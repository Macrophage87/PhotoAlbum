import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { normalizeName, replaceSpans } from "./scrub";

/**
 * What the album remembers of somebody it has forgotten: keyed hashes of their names, never the names.
 *
 * Forgetting deletes the person's record, and with it everything that knew their name — so a batch answer still on
 * its way, or a member's title about to be sent to the helper, would bring the name straight back with nobody left
 * to forget. Their full names, and a one-word name that is all of their name (never a first name taken from a full
 * one: "Florence" of "Florence Adams" is a city as often as her), are kept as HMACs, and text going to or coming from
 * the helper is checked against them a run of one to four words at a time. A one-word name, or a full name made of
 * everyday words, counts only as a name is written — "Sage", not "a sage green dress". A name somebody the album
 * knows now also answers to is not treated as forgotten: that is their name, not the forgotten person's.
 *
 * The key is derived from FORGET_HASH_KEY, a secret kept with the environment rather than in the database, so a
 * copy of the database alone is not enough to test names against the hashes. Without it (or with a different one
 * than the names were hashed under), production refuses to forget anybody and pauses the helper until it is put
 * right; anywhere else a key kept in the database stands in, with a warning.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;
const MAX_WORDS = 4;
const MAX_CJK = 12;

export type ForgetKeyState = { key: Buffer | null; id: string | null; problem: string | null; paused: boolean };

function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** The key forgotten names are hashed under, and anything admins need to put right about it. */
export async function forgetKeyState(): Promise<ForgetKeyState> {
  const e = env();
  const production = e.NODE_ENV === "production";
  const secret = e.FORGET_HASH_KEY ? Buffer.from(e.FORGET_HASH_KEY, "base64") : null;
  let key: Buffer | null = null;
  let id: string | null = null;
  let problem: string | null = null;
  if (secret && secret.length === 32) {
    key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "forgotten-names-v1", 32));
    id = `env:${fingerprint(key)}`;
  } else if (production) {
    problem = secret ? "FORGET_HASH_KEY is not 32 bytes of base64." : "FORGET_HASH_KEY is not set.";
  } else {
    // Development and tests: a key kept in the database stands in, and admins are told.
    await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", forgetKey: randomBytes(32).toString("base64") }, update: {} });
    await db.appSetting.updateMany({ where: { id: "app", forgetKey: null }, data: { forgetKey: randomBytes(32).toString("base64") } });
    const stored = (await db.appSetting.findUniqueOrThrow({ where: { id: "app" }, select: { forgetKey: true } })).forgetKey!;
    key = Buffer.from(stored, "base64");
    id = `db:${fingerprint(key)}`;
    problem = "FORGET_HASH_KEY is not set, so forgotten names are hashed under a key kept in the database. Set it before this album is used for real.";
  }
  if (id) {
    // Only an empty fingerprint is filled, so two first uses agree; a different one means the secret changed.
    await db.appSetting.updateMany({ where: { id: "app", forgetKeyFingerprint: null }, data: { forgetKeyFingerprint: id } });
    const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { forgetKeyFingerprint: true } });
    if (!setting) await db.appSetting.create({ data: { id: "app", forgetKeyFingerprint: id } }).catch(() => undefined);
    else if (setting.forgetKeyFingerprint !== id) problem = "The key forgotten names are hashed under has changed, so names forgotten before are not recognised. Put the earlier FORGET_HASH_KEY back.";
  }
  return { key, id, problem, paused: production && Boolean(problem) };
}

function hash(key: Buffer, normalized: string): string {
  return createHmac("sha256", key).update(normalized).digest("hex");
}

/** Refuse to forget anybody while their names could not be remembered safely. */
export async function assertCanForget(): Promise<void> {
  const state = await forgetKeyState();
  if (!state.key || state.paused) throw new Error(`Forgetting is paused: ${state.problem ?? "no key to hash forgotten names under"}`);
}

/** How a typed or stored name is hashed: CJK names without spaces, anything else normalized. */
function normalizedForm(f: string): string {
  return CJK.test(f) ? f.replace(/\s+/g, "") : normalizeName(f);
}

/** Remember these names of somebody being forgotten. */
export async function rememberForgotten(forms: { form: string; capitalizedOnly: boolean }[]): Promise<void> {
  const state = await forgetKeyState();
  if (!state.key || state.paused || !state.id) throw new Error(`Forgetting is paused: ${state.problem ?? "no key"}`);
  const rows = new Map<string, { hash: string; keyId: string; capitalizedOnly: boolean }>();
  for (const f of forms) {
    const n = normalizedForm(f.form);
    if (!n || n.split(" ").length > MAX_WORDS) continue;
    const h = hash(state.key, n);
    // A spelling stored both ways is matched the stricter way.
    rows.set(h, { hash: h, keyId: state.id, capitalizedOnly: (rows.get(h)?.capitalizedOnly ?? true) && f.capitalizedOnly });
  }
  if (rows.size) await db.forgottenName.createMany({ data: [...rows.values()], skipDuplicates: true });
}

/** Forgotten names an admin may allow again: when each was added, and nothing that says what it was. */
export async function forgottenNames(): Promise<{ hash: string; createdAt: Date }[]> {
  return db.forgottenName.findMany({ orderBy: { createdAt: "desc" }, select: { hash: true, createdAt: true } });
}

/** The entry a typed name would be, if it is one: for "Allow this name again" without showing any name. */
export async function forgottenHashOf(name: string): Promise<string | null> {
  const state = await forgetKeyState();
  const n = normalizedForm(name);
  return state.key && n ? hash(state.key, n) : null;
}

export type Tombstone = { empty: boolean; scrub(text: string): string; mentions(text: string): boolean };

const EMPTY: Tombstone = { empty: true, scrub: (t) => t, mentions: () => false };

/** The forgotten names, ready to check text against. */
export async function loadTombstone(): Promise<Tombstone> {
  const state = await forgetKeyState();
  if (!state.key || !state.id) return EMPTY;
  const key = state.key;
  const rows = await db.forgottenName.findMany({ where: { keyId: state.id }, select: { hash: true, capitalizedOnly: true } });
  if (!rows.length) return EMPTY;
  // Anybody the album knows now keeps their own name, whole or word by word.
  const [people, users] = await Promise.all([db.person.findMany({ select: { name: true } }), db.user.findMany({ where: { name: { not: null } }, select: { name: true } })]);
  const current = new Set<string>();
  for (const n of [...people.map((p) => p.name), ...users.map((u) => u.name ?? "")]) {
    const norm = normalizeName(n);
    if (!norm) continue;
    current.add(hash(key, norm));
    for (const w of norm.split(" ")) current.add(hash(key, w));
    if (CJK.test(n)) current.add(hash(key, n.replace(/\s+/g, "")));
  }
  const hashes = new Map(rows.filter((r) => !current.has(r.hash)).map((r) => [r.hash, r.capitalizedOnly]));
  if (!hashes.size) return EMPTY;
  const capital = (raw: string) => /^\p{Lu}/u.test(raw);

  const spansIn = (text: string): [number, number][] => {
    const spans: [number, number][] = [];
    const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.]*/gu)].map((m) => {
      // A possessive and a sentence's full stop stay outside the name.
      const raw = m[0].replace(/['’]s$/u, "").replace(/\.$/u, (d) => (/^\p{L}\.(\p{L}\.)*$/u.test(m[0]) ? d : ""));
      return { start: m.index!, end: m.index! + raw.length, raw, norm: normalizeName(raw) };
    });
    for (let i = 0; i < tokens.length; i++) {
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
        const run = tokens.slice(i, i + n);
        // Only words next to each other: a run broken by anything but a hyphen or a space is not a name.
        if (run.some((t, j) => j > 0 && !/^[\s\-‐]+$/u.test(text.slice(run[j - 1].end, t.start)))) continue;
        const capOnly = hashes.get(hash(key, run.map((t) => t.norm).join(" ")));
        if (capOnly === undefined || (capOnly && !run.every((t) => capital(t.raw)))) continue;
        spans.push([run[0].start, run[n - 1].end]);
        i += n - 1;
        break;
      }
    }
    for (const m of text.matchAll(CJK_RUN)) {
      const chars = [...m[0]];
      for (let i = 0; i < chars.length; i++) {
        for (let n = Math.min(MAX_CJK, chars.length - i); n >= 2; n--) {
          if (hashes.has(hash(key, chars.slice(i, i + n).join("")))) {
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
    scrub: (text) => (typeof text === "string" && text ? replaceSpans(text, spansIn(text)) : text),
    mentions: (text) => typeof text === "string" && spansIn(text).length > 0,
  };
}

/** The helper's record with every forgotten name taken out of its prose, and every tag or object naming one dropped. */
export function scrubRecord<T extends Partial<StoredAnnotation>>(a: T, ts: Tombstone): T {
  if (ts.empty) return a;
  const prose = (v: unknown) => (typeof v === "string" ? ts.scrub(v) : v);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t) => typeof t !== "string" || !ts.mentions(t)) : v);
  return {
    ...a,
    ...Object.fromEntries((["title", "caption", "description", "searchSummary", "place", "activity", "visibleText", "mood"] as const).filter((k) => k in a).map((k) => [k, prose(a[k])])),
    ...("tags" in a ? { tags: list(a.tags) } : {}),
    ...("objects" in a ? { objects: list(a.objects) } : {}),
  } as T;
}
