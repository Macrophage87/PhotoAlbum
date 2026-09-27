/**
 * Whether words may name somebody, for deciding what strangers may read: the share guard (namesSomebodyRestricted)
 * and a withdrawn naming's show-to-everyone (withoutWithdrawnNames). Strict on purpose: refusing leaves the words
 * with the family until a member edits them, and a leak cannot be taken back. The language rules that decide what a
 * forget rewrites (scrub.ts) are not used here: every excuse they make ("the Great", "St.", "Uncle Sam", "Will you",
 * a place after "to") was a way for a child's name to reach strangers.
 *
 * Text and names are compared alike: compatibility forms folded (NFKC), invisible characters taken out (a zero-width
 * space or a soft hyphen inside "Madison"), accents off, one apostrophe, lower case. A name is found as a whole word:
 * any full name, its first name, a nickname or former name, and a surname nobody else in the album has that is no
 * everyday word. Any match holds the words, but for exactly two things:
 * - a month used as a date, in a date's own shape: "May 2019", "May 5", "5 May", "the 5th of May", "in May." —
 *   never after "from", "by" or "of", never with a possessive, never before a verb or ", 5,";
 * - "Lake", "Mount", "Mt" or "Loch" and a listed place, with nothing after it but the end, a stop, or the time of day
 *   ("Lake Geneva at dawn.").
 */
import { PLACE_NAMES } from "./places";
import { isKinWord, isNotANameWord, isPersonVerb, isWordSurname, splitNickname } from "./scrub";

/** Text as names are compared in it. */
export function strictNormalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘ʼ`´]/gu, "'")
    .replace(/[‐‑–—]/gu, "-")
    .toLowerCase();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
/** Words before a month that make it a date, with nothing after it but an end or a number: "in May.", "late June, 2019". */
const DATE_WORDS = new Set(["in", "during", "since", "until", "till", "early", "late", "mid", "last", "next", "this"]);
const TIME_WORDS = "dawn|dusk|sunrise|sunset|night|noon|midnight|twilight|daybreak|morning|evening|afternoon";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The forms of one person's names to look for, normalized. */
function formsOf(names: string[], others: Set<string>): string[] {
  const forms = new Set<string>();
  for (const raw of names) {
    const { name, nicknames } = splitNickname(raw.trim().replace(/\s+/g, " "));
    for (const [i, n] of [name, ...nicknames].entries()) {
      const norm = strictNormalize(n).replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
      if (!norm) continue;
      if (CJK.test(norm)) {
        forms.add(norm.replace(/\s+/g, ""));
        continue;
      }
      const words = norm.split(" ").filter((w) => /\p{L}/u.test(w));
      if (!words.length) continue;
      if (words.join("").replace(/[^\p{L}]/gu, "").length >= 2) forms.add(words.join(" "));
      // Past any title or kinship word: "Grandma Ruth" is Ruth, "Dr. Ed Jones" Ed.
      let k = 0;
      while (k < words.length - 1 && isKinWord(words[k])) k++;
      const core = words.slice(k).filter((w) => !isNotANameWord(w) || words.length === 1);
      if (!core.length) continue;
      const first = core[0];
      if (first.replace(/[^\p{L}]/gu, "").length >= 2) forms.add(first);
      if (core.length >= 2) forms.add(core.join(" "));
      // A surname nobody else has and that is no everyday word ("Okafor", not "Price" or a family's shared "Shaw").
      if (i === 0 && core.length >= 2) {
        const last = core[core.length - 1];
        if (last.replace(/[^\p{L}]/gu, "").length >= 3 && !isWordSurname(last) && !isNotANameWord(last) && !others.has(last)) forms.add(last);
      }
    }
  }
  return [...forms];
}

/** A month used as a date there: see the file's comment. */
function monthAsDate(before: string, after: string): boolean {
  // A possessive, or a verb after it (a number between them too): "May's", "5 May swam", "May 5 blows".
  if (/^'s(?![\p{L}\p{N}])/u.test(after)) return false;
  const number = /^[ \t]+(\d{1,2}(?:st|nd|rd|th)?|\d{4})(?![\p{L}\p{N}])/u.exec(after) ?? /^,[ \t]*(\d{4})(?![\p{L}\p{N}])/u.exec(after);
  const rest = number ? after.slice(number[0].length) : after;
  const verb = /^[ \t]+(\p{L}+)/u.exec(rest)?.[1];
  if (verb && (isPersonVerb(verb) || /(?:ed|ing)$/u.test(verb) || /^(?:is|was|has|had|turns|turned|can|will|and)$/u.test(verb))) return false;
  if (/^,[ \t]*\d{1,3}[ \t]*,/u.test(after)) return false;
  if (number) return true;
  // "5 May", "the 5th of May", "May 2019".
  if (/(?<![\p{L}\p{N}])\d{1,2}(?:st|nd|rd|th)?[ \t]+(?:of[ \t]+)?$/u.test(before)) return /^(?:[ \t]*$|[ \t]*[.,;:!?)\n]|[ \t]+\d)/u.test(after);
  const prev = /(\p{L}+)[ \t-]+$/u.exec(before)?.[1];
  return Boolean(prev && DATE_WORDS.has(prev) && /^(?:[ \t]*$|[ \t]*[.,;:!?)\n]|[ \t]*,?[ \t]*\d)/u.test(after));
}

/** "Lake Geneva", "Mount Victoria at dawn": a listed place's name, with nothing after it but an end or the time of day. */
function lakeOrMount(match: string, before: string, after: string): boolean {
  if (!PLACE_NAMES.has(match)) return false;
  if (!/(?<![\p{L}\p{N}])(?:lake|mount|mt\.?|loch)[ \t]+$/u.test(before)) return false;
  return new RegExp(`^(?:[ \\t]+(?:(?:at|by|in)[ \\t]+)?(?:${TIME_WORDS}))?[ \\t]*(?:$|[.!?]+[ \\t]*(?:$|\\n))`, "u").test(after);
}

/**
 * A test for any mention of one person in words strangers may read. `others`: everybody else's names, whose
 * surnames are not this person's alone.
 */
export function strictMatcher(names: string[], others: string[] = []): (text: unknown) => boolean {
  const otherWords = new Set(others.flatMap((o) => strictNormalize(splitNickname(o).name).replace(/-/g, " ").split(/\s+/)).filter(Boolean));
  const own = formsOf(names, new Set());
  const forms = formsOf(names, new Set([...otherWords].filter((w) => !own.includes(w))));
  const cjk = forms.filter((f) => CJK.test(f));
  const words = forms.filter((f) => !CJK.test(f)).sort((a, b) => b.length - a.length);
  const rx = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => escape(w).replace(/ /g, "[\\s\\-]+")).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
  return (text) => {
    if (typeof text !== "string" || !text.trim()) return false;
    const t = strictNormalize(text);
    if (cjk.some((f) => t.replace(/\s+/g, "").includes(f))) return true;
    if (!rx) return false;
    for (const m of t.matchAll(rx)) {
      const before = t.slice(0, m.index);
      const after = t.slice(m.index! + m[0].length);
      if (MONTHS.has(m[0]) && monthAsDate(before, after)) continue;
      if (lakeOrMount(m[0], before, after)) continue;
      return true;
    }
    return false;
  };
}
