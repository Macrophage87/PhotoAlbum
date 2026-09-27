import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { forgetKeySecret, INVALID_FORGET_KEY } from "./forget-key";
import { Prisma } from "@/generated/prisma/client";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { inTitleCase, isEverydayWord, isKinWord, isTitlePrefix, kinshipKey, isPlaceOrDateWord, normalizeName, notThePerson, replaceSpans, type Neighbourhood } from "./scrub";

/**
 * What the album remembers of somebody it has forgotten: keyed hashes of their names, never the names.
 *
 * Forgetting deletes the person's record, and with it everything that knew their name — so a batch answer still on
 * its way, or a member's title about to be sent to the helper, would bring the name straight back with nobody left
 * to forget. Their full names, and a one-word name that is all of their name and no word ("Ximena", never "June",
 * "Grace", "Sage" or "Will", and never a first name taken from a full one), are kept as HMACs, and text going to or
 * coming from the helper is checked against them a run of one to four words at a time. A full name counts anywhere
 * (one made of everyday words only as a name is written). A one-word name counts only in text about a photograph they
 * were tagged on or that named them (kept with it, hashed) — capitalized, and not where the words around it make it something else
 * ("Florence Nightingale", "Florence, Italy"; see `notThePerson`); in tags there only as the whole tag or its
 * possessive ("ximena's pool"), and in a search summary only as a word of its own, not beside a place or a date. A name somebody the album knows now also answers to is
 * not treated as forgotten: that is their name, not the forgotten person's.
 *
 * The key is derived from FORGET_KEY, a secret kept with the environment, salted with a random value kept in the
 * database, so neither a copy of the database nor the secret alone is enough to test names against the hashes
 * (version 1). Without it a key made from the database alone stands in (version 0) outside production, with a
 * warning; names hashed under it are still recognised after FORGET_KEY is set, and admins are told how many there
 * are. Once a name has been hashed under FORGET_KEY, running without it, or with another, pauses forgetting and the
 * helper in every environment until it is put back: those names could not be recognised.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;
const MAX_WORDS = 4;
const MAX_CJK = 12;

type VersionKey = { version: number; key: Buffer };
export type ForgetKeyState = {
  /** Every key this install can reproduce, to recognise names hashed under any of them. */
  keys: VersionKey[];
  /** The key a name forgotten now is hashed under; none when nobody may be forgotten. */
  write: VersionKey | null;
  /** What admins need to put right, if anything. */
  problem: string | null;
  /** Names were hashed under a key this install cannot reproduce: nothing is forgotten or sent until it is back. */
  paused: boolean;
  /** Names hashed under the development stand-in, which a copy of the database is enough to test. */
  weak: number;
  /** FORGET_KEY is set, but not to 32 bytes of base64. */
  invalid: boolean;
};

function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** This install's random salt, made once and kept in the database. */
async function installSalt(): Promise<Buffer> {
  // Two first uses at once must agree on one salt: whichever insert or fill comes first wins, and both read it back.
  await db.$executeRaw`INSERT INTO "AppSetting" (id, "forgetKey", "updatedAt") VALUES ('app', ${randomBytes(32).toString("base64")}, now()) ON CONFLICT (id) DO NOTHING`;
  await db.appSetting.updateMany({ where: { id: "app", forgetKey: null }, data: { forgetKey: randomBytes(32).toString("base64") } });
  return Buffer.from((await db.appSetting.findUniqueOrThrow({ where: { id: "app" }, select: { forgetKey: true } })).forgetKey!, "base64");
}

/**
 * The keys forgotten names are hashed under, and anything admins need to put right about them. Version 1 is HKDF of
 * FORGET_KEY (from the environment) salted with this install's random salt (from the database). Version 0 is the
 * development stand-in, the salt alone. `forgetKeyFingerprint` records version 1's key once a name has been hashed
 * under it, so a missing or different FORGET_KEY is noticed wherever the album runs.
 */
export async function forgetKeyState(): Promise<ForgetKeyState> {
  const e = env();
  const production = e.NODE_ENV === "production";
  const secret = forgetKeySecret(e.FORGET_KEY);
  const invalid = Boolean(e.FORGET_KEY) && !secret;
  const salt = await installSalt();
  const v0: VersionKey = { version: 0, key: Buffer.from(hkdfSync("sha256", salt, Buffer.alloc(0), "forgotten-name v0", 32)) };
  const v1: VersionKey | null = secret ? { version: 1, key: Buffer.from(hkdfSync("sha256", secret, salt, "forgotten-name v1", 32)) } : null;
  const [setting, counts] = await Promise.all([
    db.appSetting.findUniqueOrThrow({ where: { id: "app" }, select: { forgetKeyFingerprint: true } }),
    db.forgottenName.groupBy({ by: ["keyVersion"], _count: { _all: true } }),
  ]);
  const count = (v: number) => counts.find((c) => c.keyVersion === v)?._count._all ?? 0;
  const recorded = setting.forgetKeyFingerprint?.startsWith("1:") ? setting.forgetKeyFingerprint.slice(2) : null;
  const matches = Boolean(v1 && (!recorded || recorded === fingerprint(v1.key)));
  const weak = count(0);
  let problem: string | null = null;
  // Names hashed under FORGET_KEY, and no FORGET_KEY (or another) to recognise them with.
  const paused = Boolean((recorded || count(1) > 0) && !matches);
  if (paused) problem = v1 ? "FORGET_KEY has changed, so names forgotten before are not recognized. Put the earlier FORGET_KEY back." : invalid ? "FORGET_KEY is set but not valid, and names were forgotten under the earlier one. Put that one back." : "FORGET_KEY is not set, and names were forgotten under it. Put it back.";
  else if (invalid) problem = `${INVALID_FORGET_KEY} Until it is, nobody is forgotten for good.`;
  else if (!v1 && production) problem = "FORGET_KEY is not set, so nobody can be forgotten until it is.";
  else if (!v1) problem = "FORGET_KEY is not set, so forgotten names are hashed under a key made from the database alone. Set it before this album is used for real.";
  else if (weak) problem = `${weak} forgotten ${weak === 1 ? "name was" : "names were"} kept before FORGET_KEY was set, under a key made from the database alone. They are still recognized, but a copy of the database is enough to test names against them.`;
  const keys = [v0, ...(v1 && matches ? [v1] : [])];
  // A key that is set but not valid never writes, in any environment: whoever set it meant names to be kept under
  // it, not under the weaker stand-in, so forgets wait until it is put right.
  const write = paused || invalid ? null : v1 && matches ? v1 : production ? null : v0;
  return { keys, write, problem, paused, weak, invalid };
}

function hash(key: Buffer, normalized: string): string {
  return createHmac("sha256", key).update(normalized).digest("hex");
}

/** What a photograph is hashed as, in a row's places and its kinship groups. */
function photoScope(id: string): string {
  return `photo:${id}`;
}

/** A photograph's, trip's, collection's or activity's place in a row (see `containerKey`), under the row's key. */
function scopeHash(key: Buffer, value: string): string {
  return hash(key, value);
}

/** Every hashed place is this; a place kept before they were hashed is a plain id or `containerKey`. */
const HASHED = /^[0-9a-f]{64}$/;

/** Places (photograph ids, or `containerKey`s) as each key's rows keep them. */
export type Places = { versions: number[]; under(version: number, values: string[], kind: "photo" | "container", plainToo?: boolean): string[] };

/**
 * Places as the rows under each of these keys keep them: hashed under the key — and, `plainToo`, as they are, for a
 * row kept before places were hashed, until `hashPlainScopes` rewrites it at start-up.
 */
function placesUnder(keys: VersionKey[]): Places {
  return {
    versions: keys.map((k) => k.version),
    under: (version, values, kind, plainToo = false) => {
      const k = keys.find((x) => x.version === version);
      const hashed = k ? values.map((v) => scopeHash(k.key, kind === "photo" ? photoScope(v) : v)) : [];
      return plainToo ? [...hashed, ...values] : hashed;
    },
  };
}

/** How a row under this key version keeps this photograph (for tests); nothing turns a hash back into an id. */
export async function hashedPhotoId(photoId: string, keyVersion: number): Promise<string | null> {
  const k = (await forgetKeyState()).keys.find((x) => x.version === keyVersion);
  return k ? scopeHash(k.key, photoScope(photoId)) : null;
}

/** Refuse to forget anybody while their names could not be remembered safely. */
export async function assertCanForget(): Promise<void> {
  const state = await forgetKeyState();
  if (!state.write) throw new Error(`Forgetting is paused: ${state.problem ?? "no key to hash forgotten names under"}`);
}

/** How a typed or stored name is hashed: CJK names without spaces, anything else normalized. */
function normalizedForm(f: string): string {
  return CJK.test(f) ? f.replace(/\s+/g, "") : normalizeName(f);
}

/**
 * Remember these names of somebody being forgotten. A one-word name is kept with the photographs whose text the
 * forget went through (they were tagged on it, or it or its trip, collection or activity named them) and those
 * trips, collections and activities (see `containerKey`) — hashed under the same key as the name — and is only ever
 * looked for there: "Florence" anywhere else is a city.
 */
/** One forgotten person's kinship titles and the photographs they were tagged on, both hashed under the row's key. */
type KinshipGroup = { photos: string[]; kin: string[] };

export async function rememberForgotten(forms: { form: string; capitalizedOnly: boolean; derived?: boolean; kinship?: string[] }[], where: { photoIds?: Iterable<string>; taggedPhotoIds?: Iterable<string>; containerIds?: Iterable<string> } = {}): Promise<void> {
  const taggedPhotoIds = [...new Set(where.taggedPhotoIds ?? [])];
  const photoIds = [...new Set([...(where.photoIds ?? []), ...taggedPhotoIds])];
  const containerIds = [...new Set(where.containerIds ?? [])];
  const state = await forgetKeyState();
  const w = state.write;
  if (!w) throw new Error(`Forgetting is paused: ${state.problem ?? "no key"}`);
  const rows = new Map<string, { hash: string; keyVersion: number; capitalizedOnly: boolean; derived: boolean; kinshipGroups: KinshipGroup[]; photoIds: string[]; taggedPhotoIds: string[]; containerIds: string[] }>();
  // Where it is looked for is kept hashed under the same key as the name: a copy of the database says nothing of
  // which photographs a forgotten entry covers.
  const hashed = { photoIds: photoIds.map((id) => scopeHash(w.key, photoScope(id))), taggedPhotoIds: taggedPhotoIds.map((id) => scopeHash(w.key, photoScope(id))), containerIds: containerIds.map((k) => scopeHash(w.key, k)) };
  for (const f of forms) {
    const n = normalizedForm(f.form);
    if (!n || n.split(" ").length > MAX_WORDS) continue;
    const h = hash(w.key, n);
    const oneWord = (!CJK.test(n) && !n.includes(" ")) || Boolean(f.derived);
    // A spelling stored both ways is matched the stricter way.
    rows.set(h, { hash: h, keyVersion: w.version, capitalizedOnly: (rows.get(h)?.capitalizedOnly ?? true) && f.capitalizedOnly, derived: (rows.get(h)?.derived ?? true) && Boolean(f.derived), kinshipGroups: oneWord ? [{ photos: hashed.taggedPhotoIds, kin: [...new Set([...(rows.get(h)?.kinshipGroups[0]?.kin ?? []), ...(f.kinship ?? []).map((k) => hash(w.key, `kin:${kinshipKey(k)}`))])] }] : [], photoIds: oneWord ? hashed.photoIds : [], taggedPhotoIds: oneWord ? hashed.taggedPhotoIds : [], containerIds: oneWord ? hashed.containerIds : [] });
  }
  if (!rows.size) return;
  // From the first name hashed under FORGET_KEY, running without that very key is noticed (see forgetKeyState).
  if (w.version === 1) await db.appSetting.updateMany({ where: { id: "app", OR: [{ forgetKeyFingerprint: null }, { NOT: { forgetKeyFingerprint: { startsWith: "1:" } } }] }, data: { forgetKeyFingerprint: `1:${fingerprint(w.key)}` } });
  // The same name forgotten again (another Ximena, on other photographs) is looked for in both places.
  for (const r of rows.values()) {
    await db.$executeRaw`
      INSERT INTO "ForgottenName" (hash, "keyVersion", "capitalizedOnly", derived, "kinshipGroups", "photoIds", "taggedPhotoIds", "containerIds")
      VALUES (${r.hash}, ${r.keyVersion}, ${r.capitalizedOnly}, ${r.derived}, ${JSON.stringify(r.kinshipGroups)}::jsonb, ${r.photoIds}::text[], ${r.taggedPhotoIds}::text[], ${r.containerIds}::text[])
      ON CONFLICT (hash) DO UPDATE SET
        "capitalizedOnly" = "ForgottenName"."capitalizedOnly" AND EXCLUDED."capitalizedOnly",
        derived = "ForgottenName".derived AND EXCLUDED.derived,
        "kinshipGroups" = COALESCE("ForgottenName"."kinshipGroups", '[]'::jsonb) || EXCLUDED."kinshipGroups",
        "photoIds" = ARRAY(SELECT DISTINCT unnest(COALESCE("ForgottenName"."photoIds", '{}') || EXCLUDED."photoIds")),
        "taggedPhotoIds" = ARRAY(SELECT DISTINCT unnest(COALESCE("ForgottenName"."taggedPhotoIds", '{}') || EXCLUDED."taggedPhotoIds")),
        "containerIds" = ARRAY(SELECT DISTINCT unnest(COALESCE("ForgottenName"."containerIds", '{}') || EXCLUDED."containerIds"))`;
  }
}

/** Forgotten names an admin may allow again: when each was added, and nothing that says what it was. */
export async function forgottenNames(): Promise<ForgottenNameRow[]> {
  const rows = await db.forgottenName.findMany({ orderBy: { createdAt: "desc" }, select: { hash: true, createdAt: true, derived: true, kinshipGroups: true, photoIds: true, containerIds: true } });
  // Enough to tell the rows apart without the name: its shape, and how far its one-word matching reaches.
  return rows.map((r) => ({
    hash: r.hash,
    createdAt: r.createdAt,
    derived: r.derived,
    oneWord: Array.isArray(r.kinshipGroups) && r.kinshipGroups.length > 0,
    photos: r.photoIds.length,
    places: r.containerIds.length,
  }));
}

export type ForgottenNameRow = { hash: string; createdAt: Date; /** The first name of a full one. */ derived: boolean; /** Looked for only where its person was. */ oneWord: boolean; photos: number; places: number };

/**
 * One line of the admin's list, telling rows apart without saying the name: "2 of 3 · a full name, forgotten Sep 27,
 * 2026, 3:14 PM". Forgetting "Sam Kent" leaves two rows at the same moment, so the shape is what separates them.
 */
export function forgottenNameLabel(f: Pick<ForgottenNameRow, "createdAt" | "derived" | "oneWord" | "photos" | "places">, index: number, total: number, timeZone?: string): string {
  const shape = f.derived
    ? "the first name of a full name"
    : f.oneWord
    ? "a one-word name"
    : "a full name";
  const reach = !(f.derived || f.oneWord)
    ? ""
    : f.photos + f.places === 0
    ? ", on no photograph yet"
    : `, looked for only on ${f.photos} photograph${f.photos === 1 ? "" : "s"}${f.places ? ` and ${f.places} trip${f.places === 1 ? "" : "s"}, collection${f.places === 1 ? "" : "s"} or activit${f.places === 1 ? "y" : "ies"}` : ""}`;
  const when = f.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone });
  return `${index + 1} of ${total} · ${shape}${reach}, forgotten ${when}`;
}

/** The entries a typed name would be under each key, for "Allow this name again" without showing any name. */
export async function forgottenHashesOf(name: string): Promise<string[]> {
  const state = await forgetKeyState();
  const n = normalizedForm(name);
  return n ? state.keys.map((k) => hash(k.key, n)) : [];
}

/** How a trip, collection or activity is kept with a one-word forgotten name. */
export function containerKey(kind: "trip" | "collection" | "activity", id: string): string {
  return `${kind}:${id}`;
}

/**
 * The one-word forgotten names in play for a text (see `forgottenScope`), as `${keyVersion}:${hash}`, and who the
 * album knows is tagged on its photographs (a living Ximena Ruiz keeps "Ximena" on hers).
 */
export type Scope = {
  rows: ReadonlySet<string>;
  /** Of those, the ones whose owner was tagged on one of these photographs, where they are the likelier reading. */
  own: ReadonlySet<string>;
  tagged: ReadonlySet<string>;
  /** The photographs themselves (none for a whole trip, collection or activity). */
  photos: ReadonlySet<string>;
  /** About a whole trip, collection or activity. */
  whole?: boolean;
};
export const NO_SCOPE: Scope = { rows: new Set(), own: new Set(), tagged: new Set(), photos: new Set() };

/**
 * Which one-word forgotten names count in text about these photographs (theirs, and their trips', collections' and
 * activities'), or about these trips, collections and activities (all their photographs, found in the database, not
 * only the few a request shows).
 */
export async function forgottenScope(where: { photoIds?: string[]; containers?: { kind: "trip" | "collection" | "activity"; id: string }[] }, ts?: Pick<Tombstone, "scoped" | "places">): Promise<Scope> {
  const photoIds = where.photoIds ?? [];
  const containers = where.containers ?? [];
  if (!photoIds.length && !containers.length) return NO_SCOPE;
  // Nothing forgotten is kept by place: nothing to look up (read once per load of the forgotten names).
  if (!(ts ? ts.scoped : await anyScoped())) return NO_SCOPE;
  const around = photoIds.length ? await db.photo.findMany({ where: { id: { in: photoIds } }, select: { tripId: true, activityId: true, collections: { select: { collectionId: true } } } }) : [];
  const keys = [
    ...containers.map((c) => containerKey(c.kind, c.id)),
    ...around.flatMap((p) => [p.tripId ? containerKey("trip", p.tripId) : null, p.activityId ? containerKey("activity", p.activityId) : null, ...p.collections.map((c) => containerKey("collection", c.collectionId))]).filter((k): k is string => Boolean(k)),
  ];
  const of = (kind: string) => containers.filter((c) => c.kind === kind).map((c) => c.id);
  // Each part on its own index; only when a whole container is asked about.
  const inContainers = containers.length
    ? Prisma.sql`SELECT id FROM "Photo" WHERE "tripId" = ANY(${of("trip")}::text[])
        UNION SELECT id FROM "Photo" WHERE "activityId" = ANY(${of("activity")}::text[])
        UNION SELECT "photoId" FROM "CollectionItem" WHERE "collectionId" = ANY(${of("collection")}::text[])`
    : null;
  const inside = inContainers ? (await db.$queryRaw<{ id: string }[]>`${inContainers}`).map((r) => r.id) : [];
  // Rows keep their places hashed under their own key (see rememberForgotten), so each key's rows are compared with
  // the places hashed under it — the few asked about as they are too, for a row from before places were hashed
  // (the start-up pass hashes those: see hashPlainScopes).
  const places = ts ? ts.places : placesUnder((await forgetKeyState()).keys);
  const matches = places.versions.map((version) => ({ version, photos: places.under(version, photoIds, "photo", true), containers: places.under(version, keys, "container", true), inside: places.under(version, inside, "photo") }));
  if (!matches.length) return NO_SCOPE;
  const [rows, tagged] = await Promise.all([
    db.$queryRaw<{ keyVersion: number; hash: string; own: boolean }[]>`
      ${Prisma.join(
        matches.map(
          (m) => Prisma.sql`SELECT "keyVersion", hash, (${containers.length === 0} AND "taggedPhotoIds" && ${m.photos}::text[]) AS own FROM "ForgottenName"
            WHERE "keyVersion" = ${m.version} AND ("photoIds" && ${m.photos}::text[] OR "containerIds" && ${m.containers}::text[] ${m.inside.length ? Prisma.sql`OR "photoIds" && ${m.inside}::text[]` : Prisma.empty})`,
        ),
        " UNION ALL ",
      )}`,
    db.$queryRaw<{ personId: string }[]>`
      SELECT "personId" FROM "Face" WHERE "personId" IS NOT NULL AND "photoId" = ANY(${photoIds}::text[])
      UNION SELECT "personId" FROM "AnimalDetection" WHERE "personId" IS NOT NULL AND "photoId" = ANY(${photoIds}::text[])
      ${inContainers ? Prisma.sql`UNION SELECT "personId" FROM "Face" WHERE "personId" IS NOT NULL AND "photoId" IN (${inContainers}) UNION SELECT "personId" FROM "AnimalDetection" WHERE "personId" IS NOT NULL AND "photoId" IN (${inContainers})` : Prisma.empty}`,
  ]);
  // A whole trip, collection or activity is about many photographs, few of them hers: the wider place guard there.
  return { rows: new Set(rows.map((r) => `${r.keyVersion}:${r.hash}`)), own: new Set(rows.filter((r) => r.own).map((r) => `${r.keyVersion}:${r.hash}`)), tagged: new Set(tagged.map((t) => t.personId)), photos: new Set(containers.length ? [] : photoIds), whole: containers.length > 0 };
}

/**
 * Rows kept before their places were hashed, rewritten with them hashed under the row's own key. At start-up and
 * overnight, with the pending forgets; a row under a key this install cannot reproduce waits until it is back. Until
 * then its places are matched as they are (see `placesUnder`). Only a row nothing else changed meanwhile is written.
 */
export async function hashPlainScopes(): Promise<number> {
  const state = await forgetKeyState();
  const rows = await db.forgottenName.findMany({ where: { keyVersion: { in: state.keys.map((k) => k.version) } }, select: { hash: true, keyVersion: true, photoIds: true, taggedPhotoIds: true, containerIds: true } });
  let done = 0;
  for (const r of rows) {
    const plain = (xs: string[]) => xs.some((x) => !HASHED.test(x));
    if (![r.photoIds, r.taggedPhotoIds, r.containerIds].some(plain)) continue;
    const key = state.keys.find((k) => k.version === r.keyVersion)!.key;
    const hashed = (xs: string[], kind: "photo" | "container") => [...new Set(xs.map((x) => (HASHED.test(x) ? x : scopeHash(key, kind === "photo" ? photoScope(x) : x))))];
    const written = await db.forgottenName.updateMany({
      where: { hash: r.hash, photoIds: { equals: r.photoIds }, taggedPhotoIds: { equals: r.taggedPhotoIds }, containerIds: { equals: r.containerIds } },
      data: { photoIds: hashed(r.photoIds, "photo"), taggedPhotoIds: hashed(r.taggedPhotoIds, "photo"), containerIds: hashed(r.containerIds, "container") },
    });
    done += written.count;
  }
  return done;
}

/**
 * Of these photographs, those tagged with more than one forgotten person under the same name ("Ada" of Ada Byron
 * and of Ada Lovelace): each forget went only by its own person's names there, so they are cleaned again with
 * every forgotten entry once the second is gone (see recleanShared).
 */
export async function sharedByNamesakes(photoIds: string[]): Promise<string[]> {
  if (!photoIds.length) return [];
  const state = await forgetKeyState();
  const places = placesUnder(state.keys);
  const out = new Set<string>();
  for (const version of places.versions) {
    const hashed = places.under(version, photoIds, "photo");
    // As they are too, for a row from before places were hashed.
    const rows = await db.$queryRaw<{ taggedPhotoIds: string[] }[]>`
      SELECT "taggedPhotoIds" FROM "ForgottenName"
      WHERE "keyVersion" = ${version} AND jsonb_array_length(COALESCE("kinshipGroups", '[]'::jsonb)) > 1 AND "taggedPhotoIds" && ${[...hashed, ...photoIds]}::text[]`;
    const kept = new Set(rows.flatMap((r) => r.taggedPhotoIds));
    photoIds.forEach((id, i) => {
      if (kept.has(hashed[i]) || kept.has(id)) out.add(id);
    });
  }
  return [...out];
}

/** Whether any forgotten name is kept with the places it was found. */
async function anyScoped(): Promise<boolean> {
  const [{ any }] = await db.$queryRaw<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ForgottenName" WHERE cardinality(COALESCE("photoIds", '{}')) > 0 OR cardinality(COALESCE("containerIds", '{}')) > 0) AS any`;
  return any;
}

/**
 * `scope`: the one-word forgotten names in play for the text (see `forgottenScope`); elsewhere only full names are
 * looked for.
 */
export type Tombstone = {
  empty: boolean;
  /** Whether any of them is a one-word name kept with the places it was found (see `forgottenScope`). */
  scoped: boolean;
  /** When it was read: a forget since then may have added names (see `tombstoneStale`). */
  loadedAt: Date;
  /** Places as the rows keep them, under each key it was read with (see `forgottenScope`). */
  places: Places;
  scrub(text: string, scope?: Scope): string;
  mentions(text: string, scope?: Scope): boolean;
  /** The helper's search summary: a one-word name only as a word of its own, not beside a place, a date or a name. */
  scrubSummary(text: string, scope?: Scope): string;
  /** Whether a tag or object names them: a full name in it, or a one-word name as the whole tag or its possessive. */
  namesTag(tag: string, scope?: Scope): boolean;
};

const empty = (loadedAt: Date, keys: VersionKey[]): Tombstone => ({ empty: true, scoped: false, loadedAt, places: placesUnder(keys), scrub: (t) => t, mentions: () => false, scrubSummary: (t) => t, namesTag: () => false });

/** Whether a forget has begun since this was read: its names may be missing from it. */
export async function tombstoneStale(ts: Tombstone): Promise<boolean> {
  const s = await db.appSetting.findUnique({ where: { id: "app" }, select: { lastForgetAt: true } });
  return Boolean(s?.lastForgetAt && s.lastForgetAt >= ts.loadedAt);
}

/** The forgotten names, ready to check text against. */
export async function loadTombstone(): Promise<Tombstone> {
  const loadedAt = new Date();
  const state = await forgetKeyState();
  const rows = await db.$queryRaw<{ hash: string; keyVersion: number; capitalizedOnly: boolean; derived: boolean; kinshipGroups: KinshipGroup[] | null; scoped: boolean }[]>`
    SELECT hash, "keyVersion", "capitalizedOnly", derived, "kinshipGroups", (cardinality(COALESCE("photoIds", '{}')) + cardinality(COALESCE("containerIds", '{}')) > 0) AS scoped
    FROM "ForgottenName" WHERE "keyVersion" = ANY(${state.keys.map((k) => k.version)}::int[])`;
  if (!rows.length) return empty(loadedAt, state.keys);
  const keys = state.keys.filter((k) => rows.some((r) => r.keyVersion === k.version));
  // Anybody the album knows now keeps their own name, whole or word by word. A one-word name kept with the places
  // it was found (scoped) is theirs only where they are tagged: "Ximena" is still taken out of the forgotten
  // Ximena's photographs while Ximena Ruiz keeps it on hers.
  const [people, users] = await Promise.all([db.person.findMany({ select: { id: true, name: true } }), db.user.findMany({ where: { name: { not: null } }, select: { name: true } })]);
  const currentForms = new Set<string>();
  const formsOf = (n: string) => {
    const norm = normalizeName(n);
    if (!norm) return [];
    return [norm, ...norm.split(" "), ...(CJK.test(n) ? [n.replace(/\s+/g, "")] : [])];
  };
  const whoseForm = new Map<string, Set<string>>();
  for (const p of people) for (const f of formsOf(p.name)) for (const k of keys) {
    const key = `${k.version}:${hash(k.key, f)}`;
    whoseForm.set(key, new Set([...(whoseForm.get(key) ?? []), p.id]));
  }
  for (const n of [...people.map((p) => p.name), ...users.map((u) => u.name ?? "")]) for (const f of formsOf(n)) currentForms.add(f);
  const current = new Set(keys.flatMap((k) => [...currentForms].map((f) => `${k.version}:${hash(k.key, f)}`)));
  const byHash = new Map(
    rows
      // A name kept by place stays, and is left alone only on photographs where somebody the album knows by it is
      // tagged (see Scope.tagged): "Sam" is Sam Ortiz's where he is, and still the forgotten Sam Kent's where he was.
      .filter((r) => r.scoped || !current.has(`${r.keyVersion}:${r.hash}`))
      .map((r) => {
        const key = `${r.keyVersion}:${r.hash}`;
        return [key, { key, capOnly: r.capitalizedOnly, derived: r.derived, kinshipGroups: r.kinshipGroups ?? [], scoped: r.scoped, people: r.scoped ? whoseForm.get(key) : undefined }] as const;
      }),
  );
  if (!byHash.size) return empty(loadedAt, keys);
  /** A forgotten name this normalized run is, if any. */
  type Found = { readonly key: string; readonly capOnly: boolean; readonly derived: boolean; readonly kinshipGroups: KinshipGroup[]; readonly scoped: boolean; readonly people: Set<string> | undefined };
  /** Every forgotten name this normalized run is, under any key (forgotten before FORGET_KEY was set, and after). */
  const lookupAll = (norm: string): Found[] => keys.map((k) => byHash.get(`${k.version}:${hash(k.key, norm)}`)).filter((v): v is Found => Boolean(v));
  const lookup = (norm: string): Found | undefined => lookupAll(norm)[0];
  const capital = (raw: string) => /^\p{Lu}/u.test(raw);
  const keyOf = (rowKey: string) => keys.find((k) => rowKey.startsWith(`${k.version}:`))!.key;
  const isNameWord = (w: string) => {
    const n = normalizeName(w);
    return currentForms.has(n) || lookup(n) !== undefined;
  };
  type Mode = "prose" | "summary" | "tag";
  const spansIn = (text: string, scope: Scope | undefined, mode: Mode): [number, number][] => {
    const spans: [number, number][] = [];
    const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.]*/gu)].map((m) => {
      // A possessive and a sentence's full stop stay outside the name.
      const raw = m[0].replace(/['’]s$/u, "").replace(/\.$/u, (d) => (/^\p{L}\.(\p{L}\.)*$/u.test(m[0]) ? d : ""));
      return { start: m.index!, end: m.index! + raw.length, raw, norm: normalizeName(raw) };
    });
    // A tag that is a one-word name, or its possessive: "ximena", "ximena's".
    const wholeTag = mode === "tag" && tokens.length === 1 && /^[\s]*[\p{L}\p{M}\p{N}'’.-]+[\s]*$/u.test(text);
    const titlePrefix = (t: { raw: string }) => /^(?:great|step|half|grand)$/iu.test(t.raw);
    for (let i = 0; i < tokens.length; i++) {
      // Not inside a title: "Great-Grandma Ruth" and "Great Grandma Ruth" are not Grandma Ruth.
      if (i > 0 && isKinWord(tokens[i].raw) && isKinWord(tokens[i - 1].raw)) {
        const sep = text.slice(tokens[i - 1].end, tokens[i].start);
        if (/^[-‐]$/u.test(sep) || (/^[ \t]+$/u.test(sep) && titlePrefix(tokens[i - 1]))) continue;
      }
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
        const run = tokens.slice(i, i + n);
        // Only words next to each other: a run broken by anything but a hyphen or a space is not a name.
        if (run.some((t, j) => j > 0 && !/^[\s\-‐]+$/u.test(text.slice(run[j - 1].end, t.start)))) continue;
        // The same name may have been forgotten more than once, under either key: whichever is in play here counts.
        const attempt = (found: Found): number | null => {
          let start = run[0].start;
          if (n === 1 || found.scoped) {
            // Only where the forget found them; a row from before that was kept, nowhere.
            if (!scope?.rows.has(found.key)) return null;
            // Somebody the album knows by that name is on these photographs: it is theirs here.
            if (found.people && [...found.people].some((id) => scope.tagged.has(id))) return null;
            if (mode === "tag") {
              if (!wholeTag) return null;
            } else if (mode === "summary") {
              // Keywords: a word of its own, in any case, but not "florence duomo" or "may 2019".
              const beside = [tokens[i - 1], tokens[i + 1]].filter(Boolean);
              if (beside.some((t) => isPlaceOrDateWord(t.raw) || /^\p{Lu}/u.test(t.raw))) return null;
            } else if (!guarded(text, run, found.capOnly, found)) return null;
            // A kinship word before it: on their own photograph it is them, and goes with the name ("Grandpa Sam at the
            // lake" is "A family member at the lake") unless their name carries another ("Aunt Ruth" is not Grandma
            // Ruth); elsewhere it is somebody else's ("Uncle Sam hat"). Their own "Grandma Ruth" is matched whole.
            let k = i > 0 && isKinWord(tokens[i - 1].raw) && !isTitlePrefix(tokens[i - 1].raw) && /^[\s]+$/u.test(text.slice(tokens[i - 1].end, run[0].start)) ? i - 1 : -1;
            // All of a hyphenated one: "Great-Aunt", "Step-Mom".
            // A descriptor before a kinship word belongs to the title too: "Big Sister Ada".
            const joins = (t: { raw: string }) => titlePrefix(t) || /^(?:big|little|baby|old|young)$/iu.test(t.raw);
            while (k > 0 && isKinWord(tokens[k - 1].raw) && (/^[-‐]$/u.test(text.slice(tokens[k - 1].end, tokens[k].start)) || (joins(tokens[k - 1]) && /^[ \t]+$/u.test(text.slice(tokens[k - 1].end, tokens[k].start))))) k--;
            if (k >= 0) {
              // Kept hashed like the names ("Tia", "Nan" and "Oma" are names too), under the row's own key.
              const kinRun = hash(keyOf(found.key), `kin:${kinshipKey(tokens.slice(k, i).map((t) => t.raw).join(" "))}`);
              // Whoever was tagged on these photographs decides: their title, or any if their name had none. Two
              // forgotten Adas keep their own ("Great Aunt Ada" on hers, "Grandma Ada" on Ada Byron's).
              const accepts = (groups: KinshipGroup[]) => groups.length === 0 || groups.some((g) => g.kin.length === 0 || g.kin.includes(kinRun));
              // Their photographs are kept hashed too, so the groups say nothing without the key.
              const here = new Set([...scope.photos].map((id) => scopeHash(keyOf(found.key), photoScope(id))));
              const theirs = found.kinshipGroups.filter((g) => g.photos.some((p) => here.has(p)));
              if (scope.own.has(found.key) && theirs.length) {
                if (!accepts(theirs)) return null;
                start = tokens[k].start;
              } else {
                if (!accepts(found.kinshipGroups)) return null;
                if (found.derived) return null;
              }
            }
          } else if (found.capOnly && !guarded(text, run, true)) return null;
          return start;
        };
        let start: number | null = null;
        for (const found of lookupAll(run.map((t) => t.norm).join(" "))) {
          start = attempt(found);
          if (start !== null) break;
        }
        if (start === null) continue;
        spans.push([start, run[n - 1].end]);
        i += n - 1;
        break;
      }
    }
    /**
     * The words around a match. A one-word name on a photograph its owner was tagged on is them wherever a place is
     * not plainly meant (a first name of a full one still a place after "to"); on one a note of theirs named them,
     * after "in" or "to" it is the place ("Duomo in Florence"); about a whole trip, the wider guard.
     */
    function placeRules(found?: { key: string; derived: boolean }): Pick<Neighbourhood, "place" | "ownPhotos" | "opening"> {
      if (!found || !scope || scope.whole) return { place: "near" };
      if (scope.own.has(found.key)) return { place: "travel", ownPhotos: true };
      return { place: "near", opening: "clear" };
    }
    function guarded(t: string, run: typeof tokens, capOnly: boolean, found?: { key: string; derived: boolean }): boolean {
      if (!capOnly) return true;
      if (!run.every((x) => capital(x.raw))) return false;
      const title = inTitleCase(t, run.map((x) => x.raw), run[0].start);
      return !notThePerson(t, run[0].start, run[run.length - 1].end, { title, date: isEverydayWord(run[0].raw), ...placeRules(found), number: true, own: new Set(run.map((x) => x.norm)), isNameWord });
    }
    for (const m of text.matchAll(CJK_RUN)) {
      const chars = [...m[0]];
      for (let i = 0; i < chars.length; i++) {
        for (let n = Math.min(MAX_CJK, chars.length - i); n >= 2; n--) {
          if (lookup(chars.slice(i, i + n).join("")) !== undefined) {
            const start = m.index! + chars.slice(0, i).join("").length;
            spans.push([start, start + chars.slice(i, i + n).join("").length]);
            i += n - 1;
            break;
          }
        }
      }
    }
    return spans.sort((a, b) => a[0] - b[0]);
  };
  return {
    empty: false,
    scoped: [...byHash.values()].some((v) => v.scoped),
    loadedAt,
    places: placesUnder(keys),
    scrub: (text, scope) => (typeof text === "string" && text ? replaceSpans(text, spansIn(text, scope, "prose")) : text),
    mentions: (text, scope) => typeof text === "string" && spansIn(text, scope, "prose").length > 0,
    scrubSummary: (text, scope) => (typeof text === "string" && text ? replaceSpans(text, spansIn(text, scope, "summary")) : text),
    namesTag: (tag, scope) => typeof tag === "string" && spansIn(tag, scope, "tag").length > 0,
  };
}

/**
 * The helper's record with every forgotten name in play (`scope`, see `forgottenScope`) taken out of its prose, and
 * every tag or object naming one dropped.
 */
export function scrubRecord<T extends Partial<StoredAnnotation>>(a: T, ts: Tombstone, scope?: Scope): T {
  if (ts.empty) return a;
  const ids = scope;
  const prose = (v: unknown) => (typeof v === "string" ? ts.scrub(v, ids) : v);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t) => typeof t !== "string" || !ts.namesTag(t, ids)) : v);
  return {
    ...a,
    ...("searchSummary" in a ? { searchSummary: typeof a.searchSummary === "string" ? ts.scrubSummary(a.searchSummary, ids) : a.searchSummary } : {}),
    ...Object.fromEntries((["title", "caption", "description", "place", "activity", "visibleText", "mood"] as const).filter((k) => k in a).map((k) => [k, prose(a[k])])),
    ...("tags" in a ? { tags: list(a.tags) } : {}),
    ...("objects" in a ? { objects: list(a.objects) } : {}),
  } as T;
}
