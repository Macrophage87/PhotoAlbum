import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { inTitleCase, isEverydayWord, normalizeName, notThePerson, replaceSpans } from "./scrub";

/**
 * What the album remembers of somebody it has forgotten: keyed hashes of their names, never the names.
 *
 * Forgetting deletes the person's record, and with it everything that knew their name — so a batch answer still on
 * its way, or a member's title about to be sent to the helper, would bring the name straight back with nobody left
 * to forget. Their full names, and a one-word name that is all of their name and no word ("Ximena", never "June",
 * "Grace", "Sage" or "Will", and never a first name taken from a full one), are kept as HMACs, and text going to or
 * coming from the helper is checked against them a run of one to four words at a time. A full name counts anywhere
 * (one made of everyday words only as a name is written). A one-word name counts only in text about a photograph they
 * were tagged on — kept with it as ids — capitalized, and not where the words around it make it something else
 * ("Florence Nightingale", "Florence, Italy"; see `notThePerson`); in tags there only as the whole tag or its
 * possessive ("ximena's pool"), and never in a search summary. A name somebody the album knows now also answers to is
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
  const secret = e.FORGET_KEY ? Buffer.from(e.FORGET_KEY, "base64") : null;
  const salt = await installSalt();
  const v0: VersionKey = { version: 0, key: Buffer.from(hkdfSync("sha256", salt, Buffer.alloc(0), "forgotten-name v0", 32)) };
  const v1: VersionKey | null = secret?.length === 32 ? { version: 1, key: Buffer.from(hkdfSync("sha256", secret, salt, "forgotten-name v1", 32)) } : null;
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
  if (paused) problem = v1 ? "FORGET_KEY has changed, so names forgotten before are not recognised. Put the earlier FORGET_KEY back." : "FORGET_KEY is not set, and names were forgotten under it. Put it back.";
  else if (secret && !v1) problem = "FORGET_KEY is not 32 bytes of base64.";
  else if (!v1 && production) problem = "FORGET_KEY is not set, so nobody can be forgotten until it is.";
  else if (!v1) problem = "FORGET_KEY is not set, so forgotten names are hashed under a key made from the database alone. Set it before this album is used for real.";
  else if (weak) problem = `${weak} forgotten ${weak === 1 ? "name was" : "names were"} kept before FORGET_KEY was set, under a key made from the database alone. They are still recognised, but a copy of the database is enough to test names against them.`;
  const keys = [v0, ...(v1 && matches ? [v1] : [])];
  const write = paused ? null : v1 && matches ? v1 : production ? null : v0;
  return { keys, write, problem, paused, weak };
}

function hash(key: Buffer, normalized: string): string {
  return createHmac("sha256", key).update(normalized).digest("hex");
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
 * Remember these names of somebody being forgotten. A one-word name is kept with the photographs they were tagged on
 * (ids only), and only ever looked for there: "Florence" anywhere else is a city.
 */
export async function rememberForgotten(forms: { form: string; capitalizedOnly: boolean }[], taggedOn: Iterable<string> = []): Promise<void> {
  const photoIds = [...new Set(taggedOn)];
  const state = await forgetKeyState();
  const w = state.write;
  if (!w) throw new Error(`Forgetting is paused: ${state.problem ?? "no key"}`);
  const rows = new Map<string, { hash: string; keyVersion: number; capitalizedOnly: boolean; photoIds: string[] }>();
  for (const f of forms) {
    const n = normalizedForm(f.form);
    if (!n || n.split(" ").length > MAX_WORDS) continue;
    const h = hash(w.key, n);
    const oneWord = !CJK.test(n) && !n.includes(" ");
    // A spelling stored both ways is matched the stricter way.
    rows.set(h, { hash: h, keyVersion: w.version, capitalizedOnly: (rows.get(h)?.capitalizedOnly ?? true) && f.capitalizedOnly, photoIds: oneWord ? photoIds : [] });
  }
  if (!rows.size) return;
  // From the first name hashed under FORGET_KEY, running without that very key is noticed (see forgetKeyState).
  if (w.version === 1) await db.appSetting.updateMany({ where: { id: "app", OR: [{ forgetKeyFingerprint: null }, { NOT: { forgetKeyFingerprint: { startsWith: "1:" } } }] }, data: { forgetKeyFingerprint: `1:${fingerprint(w.key)}` } });
  await db.forgottenName.createMany({ data: [...rows.values()], skipDuplicates: true });
}

/** Forgotten names an admin may allow again: when each was added, and nothing that says what it was. */
export async function forgottenNames(): Promise<{ hash: string; createdAt: Date }[]> {
  return db.forgottenName.findMany({ orderBy: { createdAt: "desc" }, select: { hash: true, createdAt: true } });
}

/** The entries a typed name would be under each key, for "Allow this name again" without showing any name. */
export async function forgottenHashesOf(name: string): Promise<string[]> {
  const state = await forgetKeyState();
  const n = normalizedForm(name);
  return n ? state.keys.map((k) => hash(k.key, n)) : [];
}

/**
 * `on`: the photographs a text is about (an answer's item, a request's photographs). A one-word forgotten name is
 * only looked for in text about a photograph its owner was tagged on; elsewhere only full names are.
 */
export type Tombstone = {
  empty: boolean;
  /** When it was read: a forget since then may have added names (see `tombstoneStale`). */
  loadedAt: Date;
  scrub(text: string, on?: Iterable<string>): string;
  mentions(text: string, on?: Iterable<string>): boolean;
  /** The helper's search summary: full names only, never a one-word name ("florence duomo italy"). */
  scrubSummary(text: string, on?: Iterable<string>): string;
  /** Whether a tag or object names them: a full name in it, or a one-word name as the whole tag or its possessive. */
  namesTag(tag: string, on?: Iterable<string>): boolean;
};

const empty = (loadedAt: Date): Tombstone => ({ empty: true, loadedAt, scrub: (t) => t, mentions: () => false, scrubSummary: (t) => t, namesTag: () => false });

/** Whether a forget has begun since this was read: its names may be missing from it. */
export async function tombstoneStale(ts: Tombstone): Promise<boolean> {
  const s = await db.appSetting.findUnique({ where: { id: "app" }, select: { lastForgetAt: true } });
  return Boolean(s?.lastForgetAt && s.lastForgetAt >= ts.loadedAt);
}

/** The forgotten names, ready to check text against. */
export async function loadTombstone(): Promise<Tombstone> {
  const loadedAt = new Date();
  const state = await forgetKeyState();
  const rows = await db.forgottenName.findMany({ where: { keyVersion: { in: state.keys.map((k) => k.version) } }, select: { hash: true, keyVersion: true, capitalizedOnly: true, photoIds: true } });
  if (!rows.length) return empty(loadedAt);
  const keys = state.keys.filter((k) => rows.some((r) => r.keyVersion === k.version));
  // Anybody the album knows now keeps their own name, whole or word by word.
  const [people, users] = await Promise.all([db.person.findMany({ select: { name: true } }), db.user.findMany({ where: { name: { not: null } }, select: { name: true } })]);
  const currentForms = new Set<string>();
  for (const n of [...people.map((p) => p.name), ...users.map((u) => u.name ?? "")]) {
    const norm = normalizeName(n);
    if (!norm) continue;
    currentForms.add(norm);
    for (const w of norm.split(" ")) currentForms.add(w);
    if (CJK.test(n)) currentForms.add(n.replace(/\s+/g, ""));
  }
  const current = new Set(keys.flatMap((k) => [...currentForms].map((f) => `${k.version}:${hash(k.key, f)}`)));
  const byHash = new Map(rows.filter((r) => !current.has(`${r.keyVersion}:${r.hash}`)).map((r) => [`${r.keyVersion}:${r.hash}`, { capOnly: r.capitalizedOnly, photos: new Set(r.photoIds) }]));
  if (!byHash.size) return empty(loadedAt);
  /** A forgotten name this normalized run is, if any. */
  const lookup = (norm: string): { capOnly: boolean; photos: Set<string> } | undefined => {
    for (const k of keys) {
      const v = byHash.get(`${k.version}:${hash(k.key, norm)}`);
      if (v) return v;
    }
    return undefined;
  };
  const capital = (raw: string) => /^\p{Lu}/u.test(raw);
  const isNameWord = (w: string) => {
    const n = normalizeName(w);
    return currentForms.has(n) || lookup(n) !== undefined;
  };
  // Only where its owner was tagged; a row from before photographs were kept with it, nowhere.
  const theirs = (photos: Set<string>, on: Set<string>) => [...on].some((id) => photos.has(id));

  type Mode = "prose" | "summary" | "tag";
  const spansIn = (text: string, onIds: Iterable<string> | undefined, mode: Mode): [number, number][] => {
    const on = new Set(onIds ?? []);
    const spans: [number, number][] = [];
    const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.]*/gu)].map((m) => {
      // A possessive and a sentence's full stop stay outside the name.
      const raw = m[0].replace(/['’]s$/u, "").replace(/\.$/u, (d) => (/^\p{L}\.(\p{L}\.)*$/u.test(m[0]) ? d : ""));
      return { start: m.index!, end: m.index! + raw.length, raw, norm: normalizeName(raw) };
    });
    // A tag that is a one-word name, or its possessive: "ximena", "ximena's".
    const wholeTag = mode === "tag" && tokens.length === 1 && /^[\s]*[\p{L}\p{M}\p{N}'’.-]+[\s]*$/u.test(text);
    let title: boolean | null = null;
    for (let i = 0; i < tokens.length; i++) {
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
        const run = tokens.slice(i, i + n);
        // Only words next to each other: a run broken by anything but a hyphen or a space is not a name.
        if (run.some((t, j) => j > 0 && !/^[\s\-‐]+$/u.test(text.slice(run[j - 1].end, t.start)))) continue;
        const found = lookup(run.map((t) => t.norm).join(" "));
        if (!found) continue;
        if (n === 1) {
          if (mode === "summary" || !theirs(found.photos, on)) continue;
          if (mode === "tag") {
            if (!wholeTag) continue;
          } else if (!guarded(text, run, found.capOnly)) continue;
        } else if (found.capOnly && !guarded(text, run, true)) continue;
        spans.push([run[0].start, run[n - 1].end]);
        i += n - 1;
        break;
      }
    }
    function guarded(t: string, run: typeof tokens, capOnly: boolean): boolean {
      if (!capOnly) return true;
      if (!run.every((x) => capital(x.raw))) return false;
      title ??= inTitleCase(t, run.map((x) => x.raw));
      return !notThePerson(t, run[0].start, run[run.length - 1].end, { title, date: isEverydayWord(run[0].raw), place: "near", number: true, own: new Set(run.map((x) => x.norm)), isNameWord });
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
    loadedAt,
    scrub: (text, on) => (typeof text === "string" && text ? replaceSpans(text, spansIn(text, on, "prose")) : text),
    mentions: (text, on) => typeof text === "string" && spansIn(text, on, "prose").length > 0,
    scrubSummary: (text, on) => (typeof text === "string" && text ? replaceSpans(text, spansIn(text, on, "summary")) : text),
    namesTag: (tag, on) => typeof tag === "string" && spansIn(tag, on, "tag").length > 0,
  };
}

/**
 * The helper's record about the photographs `on` with every forgotten name taken out of its prose, and every tag or
 * object naming one dropped.
 */
export function scrubRecord<T extends Partial<StoredAnnotation>>(a: T, ts: Tombstone, on: Iterable<string> = []): T {
  if (ts.empty) return a;
  const ids = [...on];
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
