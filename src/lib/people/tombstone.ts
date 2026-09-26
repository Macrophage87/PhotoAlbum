import { createHmac, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { normalizeName, replaceSpans } from "./scrub";

/**
 * What the album remembers of somebody it has forgotten: keyed hashes of their names, never the names.
 *
 * Forgetting deletes the person's record, and with it everything that knew their name — so a batch answer still on
 * its way, or a member's title about to be sent to the helper, would bring the name straight back with nobody left
 * to forget. Each of the names the forget scrub used is kept as an HMAC under a key made for this install, and text
 * going to or coming from the helper is checked against them, a run of words at a time. A name somebody the album
 * knows now also answers to is not treated as forgotten: that is their name, not the forgotten person's.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;

async function forgetKey(): Promise<string> {
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { forgetKey: true } });
  if (setting?.forgetKey) return setting.forgetKey;
  const key = randomBytes(32).toString("base64");
  // Two first uses at once must agree on one key: only an empty key is filled.
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", forgetKey: key }, update: {} });
  await db.appSetting.updateMany({ where: { id: "app", forgetKey: null }, data: { forgetKey: key } });
  return (await db.appSetting.findUniqueOrThrow({ where: { id: "app" }, select: { forgetKey: true } })).forgetKey!;
}

function hash(key: string, normalized: string): string {
  return createHmac("sha256", key).update(normalized).digest("hex");
}

/** How many units a name is compared in: words, or characters for a name written without spaces. */
function units(normalized: string): number {
  return CJK.test(normalized) ? -[...normalized.replace(/\s+/g, "")].length : normalized.split(" ").length;
}

/** Remember these names of somebody being forgotten. */
export async function rememberForgotten(forms: string[]): Promise<void> {
  const key = await forgetKey();
  const rows = [...new Set(forms.map((f) => (CJK.test(f) ? f.replace(/\s+/g, "") : normalizeName(f))).filter(Boolean))].map((n) => ({ hash: hash(key, n), words: units(n) }));
  if (rows.length) await db.forgottenName.createMany({ data: rows, skipDuplicates: true });
}

export type Tombstone = { empty: boolean; scrub(text: string): string; mentions(text: string): boolean };

const EMPTY: Tombstone = { empty: true, scrub: (t) => t, mentions: () => false };

/** The forgotten names, ready to check text against. */
export async function loadTombstone(): Promise<Tombstone> {
  const rows = await db.forgottenName.findMany({ select: { hash: true, words: true } });
  if (!rows.length) return EMPTY;
  const key = await forgetKey();
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
  const hashes = new Set(rows.map((r) => r.hash).filter((h) => !current.has(h)));
  if (!hashes.size) return EMPTY;
  const maxWords = Math.max(0, ...rows.filter((r) => r.words > 0).map((r) => r.words));
  const maxCjk = Math.max(0, ...rows.filter((r) => r.words < 0).map((r) => -r.words));

  const spansIn = (text: string): [number, number][] => {
    const spans: [number, number][] = [];
    if (maxWords) {
      const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.]*/gu)].map((m) => {
        // A possessive and a sentence's full stop stay outside the name.
        const raw = m[0].replace(/['’]s$/u, "").replace(/\.$/u, (d) => (/^\p{L}\.(\p{L}\.)*$/u.test(m[0]) ? d : ""));
        return { start: m.index!, end: m.index! + raw.length, norm: normalizeName(raw) };
      });
      for (let i = 0; i < tokens.length; i++) {
        for (let n = Math.min(maxWords, tokens.length - i); n >= 1; n--) {
          const run = tokens.slice(i, i + n);
          // Only words next to each other: a run broken by punctuation other than a hyphen or space is not a name.
          if (run.some((t, j) => j > 0 && !/^[\s\-‐]+$/u.test(text.slice(run[j - 1].end, t.start)))) continue;
          if (hashes.has(hash(key, run.map((t) => t.norm).join(" ")))) {
            spans.push([run[0].start, run[n - 1].end]);
            i += n - 1;
            break;
          }
        }
      }
    }
    if (maxCjk) {
      for (const m of text.matchAll(CJK_RUN)) {
        const chars = [...m[0]];
        for (let i = 0; i < chars.length; i++) {
          for (let n = Math.min(maxCjk, chars.length - i); n >= 2; n--) {
            if (hashes.has(hash(key, chars.slice(i, i + n).join("")))) {
              const start = m.index! + chars.slice(0, i).join("").length;
              spans.push([start, start + chars.slice(i, i + n).join("").length]);
              i += n - 1;
              break;
            }
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
