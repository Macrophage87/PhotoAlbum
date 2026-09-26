/**
 * Taking a forgotten person's name out of text the helper wrote about them. Pure, and never throws.
 *
 * The full name is matched as a whole word, ignoring case: forgetting "Ed Jones" must not touch "bedroom", and
 * forgetting "Ann Smith" must leave "Annapolis", "Ann-Marie" and "Ann Jones" alone. Words are Unicode words —
 * accents and combining marks count as letters, composed and decomposed spellings are the same name, and names in
 * scripts written without spaces (Chinese, Japanese, Korean) are matched wherever they appear. A possessive
 * ("Ann's", "Ann’s") is still the name, either apostrophe matches either, and a title may drop its period
 * ("Dr Ed Jones").
 *
 * The bare given name is only taken when that is safe: it is how a description told "Grace Hopper" says it the
 * second time, but "grace before dinner", "we may go" and "the bill" are not people. So it is matched only as it is
 * written in the name (capitalized, or in capitals inside shouting text), only for a name of two words or more,
 * only when it is three letters or longer and not a title, kinship word or everyday word, only when nobody else the
 * album knows goes by it, and never where it is plainly part of somebody else's name ("Ann Jones", "Mary Ann"). A
 * nickname in the name — "Ann (Nan) Smith", 'Robert "Bob" Jones' — counts as a full name of its own.
 */
import type { StoredAnnotation } from "@/lib/annotation/schema";

export const STAND_IN = "a family member";

/**
 * Words that are not somebody's given name when they come first: titles, kinship, descriptors, and the everyday
 * words a name field ends up starting with ("The Smiths", "Big Al", "Lil Sam").
 */
const NOT_GIVEN = new Set([
  "grandma", "grandpa", "granny", "grandad", "granddad", "grandmother", "grandfather", "gran", "nana", "nan", "papa", "pop", "pops", "mama", "ma", "pa",
  "great", "grand", "aunt", "auntie", "aunty", "uncle", "cousin", "mom", "mum", "mother", "dad", "father", "sister", "brother", "sis", "bro", "son", "daughter",
  "baby", "little", "lil", "big", "old", "young", "step", "oma", "opa", "abuela", "abuelo", "tia", "tía", "tio", "tío", "nonna", "nonno", "bubbe", "zayde",
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "professor", "sir", "dame", "lady", "lord", "rev", "fr", "st", "saint", "capt", "captain", "sgt", "col", "gen",
  "and", "the", "of", "de", "da", "del", "della", "di", "du", "van", "von", "der", "den", "la", "le", "el", "al", "bin", "ibn",
  // Months, which are names too but far more often months.
  "january", "february", "march", "april", "may", "june", "july", "august",
  // Family names usually written first, and shared by a whole family: never somebody's name on its own.
  "nguyen", "nguyễn", "tran", "trần", "lê", "pham", "phạm", "hoang", "hoàng", "huynh", "huỳnh", "vo", "võ", "dang", "đặng", "bui", "bùi", "do", "đỗ", "ngo", "ngô",
  "duong", "dương", "ly", "lý", "kim", "lee", "park", "choi", "jung", "kang", "cho", "yoon", "wang", "li", "zhang", "liu", "chen", "yang", "zhao", "huang", "zhou", "wu", "sun",
]);

/** Titles that may be written with or without a period. */
const TITLES = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "st", "capt", "sgt", "col", "gen", "jr", "sr"]);

const WORD = "\\p{L}\\p{M}\\p{N}";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bare(word: string) {
  return word.replace(/[.,]+$/, "").toLowerCase();
}

/** "Ann (Nan) Smith" is "Ann Smith", also called "Nan"; 'Robert "Bob" Jones' is also "Bob". */
function splitNickname(name: string): { name: string; nicknames: string[] } {
  const nicknames: string[] = [];
  const rest = name.replace(/\(([^()]+)\)|"([^"]+)"|“([^”]+)”|‘([^’]+)’/gu, (_m: string, a?: string, b?: string, c?: string, d?: string) => {
    const nick = (a ?? b ?? c ?? d ?? "").trim().replace(/\s+/g, " ");
    if (nick) nicknames.push(nick);
    return " ";
  });
  return { name: rest.trim().replace(/\s+/g, " "), nicknames };
}

/** The given name to match on its own, when it is safe to; otherwise null and only full names are matched. */
export function safeGivenName(name: string, others: string[] = []): string | null {
  const { name: plain } = splitNickname(typeof name === "string" ? name : "");
  const words = plain.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const given = words[0].replace(/[.,]+$/, "");
  if ([...given].filter((c) => /\p{L}/u.test(c)).length < 3) return null;
  if (NOT_GIVEN.has(bare(given)) || CJK.test(given)) return null;
  // Somebody else answering to it makes it nobody in particular.
  const mine = plain.toLowerCase();
  for (const o of others) {
    if (typeof o !== "string") continue;
    const theirs = splitNickname(o).name;
    if (!theirs || theirs.toLowerCase() === mine) continue;
    if (theirs.split(" ").some((w) => bare(w) === bare(given))) return null;
  }
  return given;
}

/** Every spelling of every name the person has gone by, longest first: the name, its nicknames, NFC and NFD. */
export function fullForms(names: string[]): string[] {
  const forms: string[] = [];
  for (const n of names) {
    if (typeof n !== "string") continue;
    const { name, nicknames } = splitNickname(n.trim().replace(/\s+/g, " "));
    for (const f of [name, ...nicknames]) if (f && /[\p{L}\p{N}]/u.test(f)) forms.push(f);
  }
  const all = forms.flatMap((f) => [f.normalize("NFC"), f.normalize("NFD")]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** One spelling as a pattern: any run of spaces between words, either apostrophe, a title's period optional. */
function formPattern(form: string): string {
  const body = form
    .split(" ")
    .map((w) => {
      const plain = w.replace(/\.$/, "");
      const dot = TITLES.has(plain.toLowerCase()) ? "\\.?" : w.endsWith(".") ? "\\." : "";
      return escape(plain).replace(/['’]/g, "['’]").replace(/[-‐]/g, "[-‐]") + dot;
    })
    .join("\\s+");
  if (CJK.test(form)) return body;
  // Not inside a longer word, nor the "Neil" of "O'Neil" or the "Ann" of "Ann-Marie"; an apostrophe after it is a
  // possessive and stays outside the match.
  return `(?<![${WORD}])(?<![${WORD}][-‐'’])${body}(?![${WORD}])(?![-‐][${WORD}])`;
}

function isUpperWord(w: string) {
  return /\p{L}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase();
}

/** The words either side of a match, for deciding its case. */
function neighbours(before: string, after: string): { prev: string | null; next: string | null } {
  const prev = before.match(/([\p{L}\p{M}'’-]+)[^\p{L}\p{M}]*$/u)?.[1] ?? null;
  const next = after.match(/^[^\p{L}\p{M}]*([\p{L}\p{M}'’-]+)/u)?.[1] ?? null;
  return { prev, next };
}

/** At the start of the text, of a line, or of a sentence — after any opening quote, bracket or markdown. */
function startsSentence(before: string): boolean {
  const lead = before.match(/[\s"'“‘(\[*_#>\-–—•]*$/u)?.[0] ?? "";
  const rest = before.slice(0, before.length - lead.length);
  return rest === "" || lead.includes("\n") || /[.!?…]["'”’)\]]*$/u.test(rest);
}

function standIn(match: string, before: string, after: string): string {
  const { prev, next } = neighbours(before, after);
  const around = [prev, next].filter((w): w is string => Boolean(w));
  // Shouting only where the words around it shout too: "HAPPY BIRTHDAY ADA", not "ADA" in an ordinary sentence.
  const letters = match.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && isUpperWord(letters) && around.every(isUpperWord)) return STAND_IN.toUpperCase();
  return startsSentence(before) ? STAND_IN[0].toUpperCase() + STAND_IN.slice(1) : STAND_IN;
}

export type NameMatcher = {
  /** The text with every mention replaced by "a family member"; anything that is not a string comes back as it was. */
  scrub<T>(text: T): T;
  /** Whether the text mentions them, by exactly the same rules. */
  mentions(text: unknown): boolean;
  /** Whether a tag or object is about them: the name itself, or containing the full name or its possessive. */
  namesTag(tag: unknown): boolean;
  /** Every spelling that can match (full forms and a safe given name), for a database pre-filter. */
  forms: string[];
};

/**
 * A matcher for one person: every name they have gone by (`names`), and the names of everybody else the album
 * knows (`others`), which decide whether this person's given name is theirs alone.
 */
export function nameMatcher(names: string[], others: string[] = []): NameMatcher {
  const list = (Array.isArray(names) ? names : []).filter((n): n is string => typeof n === "string" && n.trim() !== "");
  const forms = fullForms(list);
  const givens = [...new Set(list.map((n) => safeGivenName(n, Array.isArray(others) ? others : [])).filter((g): g is string => Boolean(g)))];
  const fullSource = forms.map(formPattern).join("|");
  const full = forms.length ? new RegExp(fullSource, "giu") : null;
  const fullTest = forms.length ? new RegExp(fullSource, "iu") : null;
  // Case-sensitive, as written: "Grace" and not "grace".
  const variants = (f: (g: string) => string) => givens.flatMap((g) => [f(g).normalize("NFC"), f(g).normalize("NFD")]).map(formPattern).join("|");
  const given = givens.length ? new RegExp(variants((g) => g), "gu") : null;
  const givenCaps = givens.length ? new RegExp(variants((g) => g.toUpperCase()), "gu") : null;
  const kinship = (w: string | null) => Boolean(w) && NOT_GIVEN.has(bare(w!));

  const scrubText = (text: string): string => {
    let out = full ? text.replace(full, (m: string, offset: number, whole: string) => standIn(m, whole.slice(0, offset), whole.slice(offset + m.length))) : text;
    if (given) {
      out = out.replace(given, (m: string, offset: number, whole: string) => {
        const before = whole.slice(0, offset);
        const after = whole.slice(offset + m.length);
        // Only the words right beside it, with nothing but spaces between.
        const prev = before.match(/([\p{L}\p{M}'’-]+)[ \t]+$/u)?.[1] ?? null;
        const next = after.match(/^[ \t]+([\p{L}\p{M}'’-]+)/u)?.[1] ?? null;
        // "Ann Jones" is somebody else.
        if (next && /^\p{Lu}/u.test(next)) return m;
        // So is "Mary Ann" — unless the word before is only what the family calls her ("Aunt Grace"), or it starts
        // the sentence ("Then Grace swam").
        if (prev && /^\p{Lu}/u.test(prev) && !kinship(prev) && !startsSentence(before.slice(0, before.length - before.match(/[\p{L}\p{M}'’-]+[ \t]+$/u)![0].length))) return m;
        return standIn(m, before, after);
      });
    }
    // In capitals only where everything is in capitals: a banner or a cake, transcribed.
    if (givenCaps && /\p{L}/u.test(out) && out === out.toUpperCase()) out = out.replace(givenCaps, () => STAND_IN.toUpperCase());
    return out;
  };

  const scrub = <T,>(text: T): T => {
    if (typeof text !== "string" || !text) return text;
    try {
      return scrubText(text) as T;
    } catch {
      return text;
    }
  };
  const mentions = (text: unknown) => typeof text === "string" && text !== "" && scrub(text) !== text;
  const namesTag = (tag: unknown) => {
    if (typeof tag !== "string") return false;
    const t = tag.trim().toLowerCase().replace(/’/g, "'");
    if (!t) return false;
    if (givens.some((g) => t === g.toLowerCase() || t === `${g.toLowerCase()}'s`)) return true;
    return Boolean(fullTest?.test(tag));
  };
  return { scrub, mentions, namesTag, forms: [...forms, ...givens] };
}

/**
 * The helper's record with the name taken out of every piece of prose, and every tag or object naming them
 * dropped: a keyword like "ada" or "ada's birthday" is only there to find her. A malformed record (a missing list, a
 * number where text was expected) comes back well-formed rather than throwing.
 */
export function scrubAnnotation(a: StoredAnnotation, m: NameMatcher): StoredAnnotation {
  const text = (v: unknown) => (typeof v === "string" ? m.scrub(v) : "");
  const maybe = (v: unknown) => (typeof v === "string" ? m.scrub(v) : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && !m.namesTag(t)) : []);
  return {
    ...a,
    title: text(a.title),
    caption: text(a.caption),
    description: text(a.description),
    searchSummary: text(a.searchSummary),
    place: maybe(a.place),
    activity: maybe(a.activity),
    visibleText: maybe(a.visibleText),
    mood: maybe(a.mood),
    tags: list(a.tags),
    objects: list(a.objects),
  };
}

/** Whether any prose field of the helper's record, or any tag or object, mentions them. */
export function annotationMentions(a: unknown, m: NameMatcher): boolean {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return ["title", "caption", "description", "searchSummary", "place", "activity", "visibleText", "mood"].some((k) => m.mentions(r[k])) || [r.tags, r.objects].some((l) => Array.isArray(l) && l.some((t) => m.namesTag(t)));
}
