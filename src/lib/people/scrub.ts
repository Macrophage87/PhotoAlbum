/**
 * Taking a forgotten person's name out of text the helper wrote about them. Pure, and never throws.
 *
 * Two kinds of spelling, treated very differently, because the damage a scrub can do is in the second kind:
 *
 * - A full name of two words or more ("Ada Byron", "Grandma Jo") is matched as a whole word in any case, anywhere.
 *   Accents, combining marks and spellings with the accents left off ("Jose" for "José") count, as do either
 *   apostrophe, a possessive, a hyphen or a space between its parts ("Ann-Marie", "Ann Marie"), and periods that are
 *   there or not ("Dr Ed Jones", "JR Smith" for "J.R. Smith").
 * - A short name — a one-word name, a one-word former name or nickname, and the first word of a full name — is only
 *   matched capitalized as written (or in capitals: "Happy Birthday GRACE!"), so "grace before dinner", "we may go"
 *   and "the bill" are never touched. It is used everywhere only when it is safe: three letters or longer, not a
 *   title, kinship word or everyday word ("Grace", "May", "Bill", "Rose"), and not a word of anybody else's name the
 *   album knows. A short name that is not safe is used only on the photographs the person is, or was, tagged on —
 *   where "Grace" in the helper's text really is her — and a derived first name that is not safe is not used at all.
 *   Beside another capitalized name it is somebody else's ("Ann Jones", "Mary Grace"), except in a title written in
 *   title case ("Grace Swimming At The Lake") and after a word that only says when or who ("On Sunday Grace swam",
 *   "Aunt Grace").
 *
 * Names in scripts written without spaces (Chinese, Japanese, Korean) are matched wherever they occur, spaces between
 * their parts or not, except inside somebody else's name that contains them.
 */
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { COMMON_WORD_NAMES, KINSHIP_WORDS, NAME_PARTICLES } from "@/lib/annotation/names";

export const STAND_IN = "a family member";

/** Titles, kinship and descriptors: never somebody's name on its own, and fine to stand in front of one. */
const KINSHIP = [
  "grandma", "grandpa", "granny", "grandad", "granddad", "grandmother", "grandfather", "gran", "nana", "nan", "papa", "pop", "pops", "mama", "ma", "pa",
  "great", "grand", "aunt", "auntie", "aunty", "uncle", "cousin", "mom", "mum", "mother", "dad", "father", "sister", "brother", "sis", "bro", "son", "daughter",
  "baby", "little", "lil", "big", "old", "young", "step", "oma", "opa", "abuela", "abuelo", "tia", "tía", "tio", "tío", "nonna", "nonno", "bubbe", "zayde",
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "professor", "sir", "dame", "lady", "lord", "rev", "fr", "st", "saint", "capt", "captain", "sgt", "col", "gen",
];

/**
 * Names that are also everyday words, months, particles and the family names usually written first: never matched
 * on their own away from the person's own photographs.
 */
const EVERYDAY = [
  "and", "the", "of", "de", "da", "del", "della", "di", "du", "van", "von", "der", "den", "la", "le", "el", "al", "bin", "ibn",
  "grace", "will", "may", "rose", "bill", "joy", "hope", "mark", "pat", "art", "frank", "guy", "sunny", "summer", "autumn", "winter", "dawn", "holly", "ivy",
  "amber", "faith", "chase", "hunter", "carol", "lily", "iris", "violet", "daisy", "olive", "hazel", "heather", "fern", "poppy", "jasmine", "ruby", "pearl",
  "crystal", "jade", "coral", "ginger", "honey", "penny", "sandy", "rusty", "sky", "river", "storm", "rain", "eve", "charity", "patience", "mercy", "jack",
  "ray", "rich", "rob", "sue", "drew", "gene", "lance", "miles", "pierce", "reed", "wade", "bob", "don", "dean", "earl", "sterling", "august", "april", "june",
  "january", "february", "march", "july", "christian", "angel", "star", "stormy", "cash", "king", "prince", "duke", "bishop", "noble", "major", "gay",
  "nguyen", "nguyễn", "tran", "trần", "lê", "pham", "phạm", "hoang", "hoàng", "huynh", "huỳnh", "vo", "võ", "dang", "đặng", "bui", "bùi", "do", "đỗ", "ngo", "ngô",
  "duong", "dương", "ly", "lý", "kim", "lee", "park", "choi", "jung", "kang", "cho", "yoon", "wang", "li", "zhang", "liu", "chen", "yang", "zhao", "huang", "zhou", "wu", "sun",
];
// The members-only matcher's lists (src/lib/annotation/names.ts) are part of the same judgement: whatever it treats
// as an everyday word, a particle or a kinship word, so does this.
const NOT_SAFE = new Set([...KINSHIP, ...EVERYDAY, ...KINSHIP_WORDS, ...COMMON_WORD_NAMES, ...NAME_PARTICLES]);
const KIN = new Set([...KINSHIP, ...KINSHIP_WORDS]);
/** A full name needs one word that is more than a title, a kinship word or a particle ("Big Al" is not enough). */
const NOT_A_NAME_WORD = new Set([...KIN, ...NAME_PARTICLES, "and", "the", "of", "al", "el"]);

/** Capitalized words that say when, or start a sentence, rather than being somebody's name before another. */
const STARTERS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "christmas", "easter", "thanksgiving", "halloween", "hanukkah", "new", "year", "years",
  "then", "when", "on", "in", "at", "after", "before", "today", "yesterday", "tomorrow", "tonight", "here", "there", "later", "now", "while", "with", "and", "but",
  "so", "as", "since", "meanwhile", "finally", "also", "even", "only", "just", "maybe", "perhaps", "dear", "happy", "love", "hi", "hello", "thanks", "by",
  "for", "from", "to", "of", "into", "is", "was", "the", "a", "an", "this", "that", "look", "see", "meet", "oh", "yes", "no", "our", "my", "little", "baby",
]);

const WORD = "\\p{L}\\p{M}\\p{N}";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bare(word: string) {
  return word.replace(/[.,]/g, "").toLowerCase();
}

function letters(s: string) {
  return [...s].filter((c) => /\p{L}/u.test(c)).length;
}

function unaccented(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
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

function wordsOf(name: string): string[] {
  return name.split(/[\s\-‐]+/).filter(Boolean);
}

/** The pattern for one spelling: parts joined by spaces or a hyphen, either apostrophe, every period optional. */
function body(form: string): string {
  return wordsOf(form)
    .map((w) => escape(w).replace(/\\\./g, "\\.?").replace(/['’]/g, "['’]"))
    .join("(?:\\s+|[-‐])");
}

/**
 * Not inside a longer word, nor the "Neil" of "O'Neil" or the "Marie" of "Ann-Marie" — but after a French or
 * Italian elision ("l'Ann", "d'Ada") it is the name. An apostrophe after it is a possessive and stays outside.
 */
const BEFORE = `(?<![${WORD}])(?<![${WORD}][-‐])(?<![${WORD}]{2}['’])(?<!(?<![${WORD}])[^\\P{L}lLdDjJmMnNsStTcCqQ]['’])`;
const AFTER = `(?![${WORD}])(?![-‐][${WORD}])`;

function bounded(forms: string[]): string {
  return forms.map((f) => `${BEFORE}${body(f)}${AFTER}`).join("|");
}

/** Written with or without spaces between its characters. */
function cjkBody(form: string): string {
  return [...form.replace(/\s+/g, "")].map(escape).join("\\s*");
}

function isUpperWord(w: string) {
  return /\p{L}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase();
}

/** A title in title case ("Grace Swimming At The Lake"): capitals there say nothing about names. */
function titleCase(text: string): boolean {
  const words = text.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? [];
  if (words.length < 3) return false;
  return words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

/** At the start of the text, of a line, or of a sentence — after any opening quote, bracket or markdown. */
function startsSentence(before: string): boolean {
  const lead = before.match(/[\s"'“‘(\[*_#>\-–—•]*$/u)?.[0] ?? "";
  const rest = before.slice(0, before.length - lead.length);
  return rest === "" || lead.includes("\n") || /[.!?…]["'”’)\]]*$/u.test(rest);
}

function standIn(match: string, before: string, after: string): string {
  const prev = before.match(/([\p{L}\p{M}'’-]+)[^\p{L}\p{M}]*$/u)?.[1] ?? null;
  const next = after.match(/^[^\p{L}\p{M}]*([\p{L}\p{M}'’-]+)/u)?.[1] ?? null;
  const around = [prev, next].filter((w): w is string => Boolean(w));
  // Shouting only where the words around it shout too: "HAPPY BIRTHDAY ADA", not "Happy Birthday ADA".
  const l = match.replace(/[^\p{L}]/gu, "");
  if (l.length > 1 && isUpperWord(l) && around.every(isUpperWord)) return STAND_IN.toUpperCase();
  return startsSentence(before) ? STAND_IN[0].toUpperCase() + STAND_IN.slice(1) : STAND_IN;
}

/** Where a text is: on one of the person's own (tagged, or once tagged) photographs, or anywhere else. */
export type Where = { tagged?: boolean };

export type NameMatcher = {
  /** The text with every mention replaced by "a family member"; anything that is not a string comes back as it was. */
  scrub<T>(text: T, where?: Where): T;
  /** Whether the text mentions them, by exactly the same rules. */
  mentions(text: unknown, where?: Where): boolean;
  /** Whether a tag or object is about them: their name itself, or containing a full name of theirs. */
  namesTag(tag: unknown, where?: Where): boolean;
  /** Full names safe to look for anywhere in the album, for a database pre-filter; empty when there are none. */
  albumForms: string[];
  /** Every spelling, for a pre-filter over the person's own photographs. */
  forms: string[];
};

/**
 * A matcher for one person: every name they have gone by (`names`), and the names of everybody else the album
 * knows (`others`), which decide whether a short name of theirs is theirs alone.
 */
export function nameMatcher(names: string[], others: string[] = []): NameMatcher {
  const list = (Array.isArray(names) ? names : []).filter((n): n is string => typeof n === "string" && n.trim() !== "");
  const otherNames = (Array.isArray(others) ? others : []).filter((o): o is string => typeof o === "string" && o.trim() !== "");
  const own = new Set(list.flatMap((n) => wordsOf(splitNickname(n).name).map(bare)));
  const theirs = otherNames.flatMap((o) => wordsOf(splitNickname(o).name).map(bare));
  // Any word of anybody else's name makes a short name of theirs ambiguous; beside a match, only words not also theirs
  // say it is somebody else ("Ada Lovelace" beside "Ada Byron"'s "Ada" is somebody else, "Byron" is not).
  const shared = new Set(theirs);
  const otherWords = new Set(theirs.filter((w) => !own.has(w)));

  const longs: string[] = []; // any case, anywhere
  const shorts: string[] = []; // as written, anywhere
  const whole: string[] = []; // short names that are a whole name of theirs, not the first word of one
  const tagged: string[] = []; // as written, on their own photographs only
  const cjk: string[] = [];
  const safeShort = (w: string) => letters(w) >= 3 && !NOT_SAFE.has(bare(w)) && !shared.has(bare(w));
  const capitalized = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  for (const n of list) {
    const { name, nicknames } = splitNickname(n.trim().replace(/\s+/g, " "));
    for (const [i, s] of [name, ...nicknames].entries()) {
      if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
      if (CJK.test(s)) {
        if ([...s.replace(/\s+/g, "")].length >= 2) cjk.push(s);
        continue;
      }
      const words = wordsOf(s);
      if (words.length >= 2) {
        // A full name made only of titles, kinship words and particles ("Big Al") is no safer than a short one.
        if (words.some((w) => letters(w) >= 2 && !NOT_A_NAME_WORD.has(bare(w)))) longs.push(s);
        else tagged.push(s);
        // Its first word said on its own, when that is safe; otherwise not at all.
        if (i === 0 && safeShort(words[0])) shorts.push(capitalized(words[0]));
      } else if (safeShort(s)) {
        shorts.push(capitalized(s));
        whole.push(s);
      }
      else if (letters(s) >= 2) tagged.push(capitalized(s));
    }
  }
  const variants = (forms: string[]) => [...new Set(forms.flatMap((f) => [f.normalize("NFC"), f.normalize("NFD"), unaccented(f)]))].sort((a, b) => b.length - a.length);
  const longForms = variants(longs);
  const shortForms = variants(shorts);
  const taggedForms = variants(tagged);
  const cjkForms = [...new Set(cjk)].sort((a, b) => b.length - a.length);

  const longRx = longForms.length ? new RegExp(bounded(longForms), "giu") : null;
  const longTest = longForms.length ? new RegExp(bounded(longForms), "iu") : null;
  const wholeForms = variants(whole);
  const wholeTest = wholeForms.length ? new RegExp(bounded(wholeForms), "iu") : null;
  const cjkRx = cjkForms.length ? new RegExp(cjkForms.map(cjkBody).join("|"), "gu") : null;
  // Somebody else's name that contains one of theirs: "花子" is not forgotten inside "山田花子".
  const cjkOthers = otherNames.filter((o) => CJK.test(o) && cjkForms.some((f) => o.replace(/\s+/g, "").includes(f.replace(/\s+/g, "")) && o.replace(/\s+/g, "") !== f.replace(/\s+/g, "")));
  const cjkOthersRx = cjkOthers.length ? new RegExp(cjkOthers.map(cjkBody).join("|"), "gu") : null;
  const caseSensitive = (forms: string[]) => (forms.length ? new RegExp(bounded(forms.flatMap((f) => [f, f.toUpperCase()])), "gu") : null);
  const shortRx = caseSensitive(shortForms);
  const shortAndTaggedRx = caseSensitive([...shortForms, ...taggedForms]);

  const shortReplacer = (m: string, offset: number, whole: string, title: boolean): string => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + m.length);
    const prev = before.match(/([\p{L}\p{M}'’.-]+)[ \t]+$/u)?.[1] ?? null;
    const next = after.match(/^[ \t]+([\p{L}\p{M}'’.-]+)/u)?.[1] ?? null;
    // Part of somebody else's name the album knows: "Grace Kelly", "Mary Grace".
    if ((prev && otherWords.has(bare(prev))) || (next && otherWords.has(bare(next)))) return m;
    const caps = isUpperWord(m);
    if (!title && !caps) {
      // "Ann Jones" is somebody else...
      if (next && /^\p{Lu}/u.test(next)) return m;
      // ...and so is "Mary Ann", unless the word before only says when ("On Sunday Grace") or who she is to them
      // ("Aunt Grace").
      if (prev && /^\p{Lu}/u.test(prev) && !KIN.has(bare(prev)) && !STARTERS.has(bare(prev))) return m;
    }
    return standIn(m, before, after);
  };

  const scrubText = (text: string, where: Where): string => {
    let out = longRx ? text.replace(longRx, (m: string, offset: number, whole: string) => standIn(m, whole.slice(0, offset), whole.slice(offset + m.length))) : text;
    if (cjkRx) {
      const inside: [number, number][] = [];
      if (cjkOthersRx) for (const o of out.matchAll(cjkOthersRx)) inside.push([o.index!, o.index! + o[0].length]);
      out = out.replace(cjkRx, (m: string, offset: number, whole: string) => (inside.some(([a, b]) => offset >= a && offset + m.length <= b) ? m : standIn(m, whole.slice(0, offset), whole.slice(offset + m.length))));
    }
    const rx = where.tagged ? shortAndTaggedRx : shortRx;
    if (rx) {
      const title = titleCase(out);
      out = out.replace(rx, (m: string, offset: number, whole: string) => shortReplacer(m, offset, whole, title));
    }
    return out;
  };

  const scrub = <T,>(text: T, where: Where = {}): T => {
    if (typeof text !== "string" || !text) return text;
    try {
      return scrubText(text, where) as T;
    } catch {
      return text;
    }
  };
  const mentions = (text: unknown, where: Where = {}) => typeof text === "string" && text !== "" && scrub(text, where) !== text;
  const namesTag = (tag: unknown, where: Where = {}) => {
    if (typeof tag !== "string") return false;
    const t = tag.trim().toLowerCase().replace(/’/g, "'");
    if (!t) return false;
    const exact = [...shortForms, ...(where.tagged ? taggedForms : [])].map((f) => f.toLowerCase());
    if (exact.some((f) => t === f || t === `${f}'s`)) return true;
    if (cjkForms.some((f) => t.replace(/\s+/g, "").includes(f.replace(/\s+/g, "")))) return true;
    // A one-word name that is safe is their whole name: a tag containing it ("ada's dog") is about them.
    if (wholeTest?.test(tag)) return true;
    return Boolean(longTest?.test(tag));
  };
  // A pre-filter needs something long enough to be selective: "Al" would match every other row.
  const albumForms = longForms.filter((f) => letters(f) >= 3);
  return { scrub, mentions, namesTag, albumForms: [...albumForms, ...cjkForms], forms: [...longForms, ...shortForms, ...taggedForms, ...cjkForms] };
}

/**
 * The helper's record with the name taken out of every piece of prose, and every tag or object naming them
 * dropped: a keyword like "ada" or "ada's birthday" is only there to find her. A malformed record (a missing list, a
 * number where text was expected) comes back well-formed rather than throwing.
 */
export function scrubAnnotation(a: StoredAnnotation, m: NameMatcher, where: Where = {}): StoredAnnotation {
  const text = (v: unknown) => (typeof v === "string" ? m.scrub(v, where) : "");
  const maybe = (v: unknown) => (typeof v === "string" ? m.scrub(v, where) : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && !m.namesTag(t, where)) : []);
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
export function annotationMentions(a: unknown, m: NameMatcher, where: Where = {}): boolean {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return ["title", "caption", "description", "searchSummary", "place", "activity", "visibleText", "mood"].some((k) => m.mentions(r[k], where)) || [r.tags, r.objects].some((l) => Array.isArray(l) && l.some((t) => m.namesTag(t, where)));
}
