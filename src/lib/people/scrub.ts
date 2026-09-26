/**
 * Taking a forgotten person's name out of text the helper wrote about them. Pure, and never throws.
 *
 * The damage a scrub can do is in short names — "Grace", "May", "Bill" — so where it looks decides what it uses:
 *
 * - A full name of two words or more ("Ada Byron", and "Ed Jones" of "Dr. Ed Jones") is matched as a whole word in
 *   any case, anywhere; one made only of everyday words ("Holly Berry") only capitalized, as a name is written.
 *   Accents or none ("Jose" for "José"), either apostrophe, a possessive, a hyphen or a space between parts
 *   ("Ann-Marie", "Ann Marie"), and periods there or not ("JR Smith") all count.
 * - A short name — a one-word name, nickname or former name, or the first name of a full one after any title or
 *   kinship word ("Ruth" of "Grandma Ruth") — is only matched capitalized as written, or in capitals. Anywhere, only
 *   when it is safe: three letters or longer, not an everyday word or month, and not a word of anybody else's name.
 *   On the person's own photographs (tagged, or once tagged) it is always theirs — unless somebody else tagged on
 *   the same photograph shares it — except where a month or everyday word is plainly a date ("in May", "May 5").
 * - On their own photographs, every word of their name (surname included) also counts in the helper's keywords, in
 *   any case: "ada birthday cake" and the tag "grandma ada" are about her there.
 *
 * Beside another capitalized name a short name is somebody else's ("Ann Jones", "Mary Grace"), except in a title in
 * title case, after a word that only says when ("On Sunday Grace swam"), or after a kinship word ("Aunt Grace").
 *
 * Names in scripts written without spaces (Chinese, Japanese, Korean) are matched with or without spaces between
 * their characters, and never inside somebody else's name containing them. One of several parts, or of three
 * characters or more that are not only kana, is used anywhere; a shorter one, which is as often a word ("さくら",
 * "春花"), only on their own photographs.
 */
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { COMMON_WORD_NAMES, KINSHIP_WORDS, NAME_PARTICLES } from "@/lib/annotation/names";
import { PLACE_NAMES } from "./places";

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
  "berry", "hill", "brook", "wood", "field", "stone", "rivers", "woods", "banks",
  // Herbs, birds, trees and plants: "Sage green walls", "a robin on the fence".
  "sage", "basil", "robin", "rosemary", "thyme", "wren", "jay", "lark", "rowan", "laurel", "willow", "aspen", "birch", "cedar", "linden", "juniper",
  "myrtle", "clover", "sorrel", "saffron", "cinnamon", "pepper", "mint", "parsley", "fennel", "finch", "raven", "sparrow", "dove", "hawk", "falcon",
  "heath", "blossom", "marigold", "primrose", "bryony", "tansy", "yarrow", "acacia", "magnolia", "dahlia", "lavender", "posy",
];
// The members-only matcher's lists (src/lib/annotation/names.ts) are part of the same judgement: whatever it treats
// as an everyday word, a particle or a kinship word, so does this.
const NOT_SAFE = new Set([...KINSHIP, ...EVERYDAY, ...KINSHIP_WORDS, ...COMMON_WORD_NAMES, ...NAME_PARTICLES]);
const KIN = new Set([...KINSHIP, ...KINSHIP_WORDS]);
/** A full name needs one word that is more than a title, a kinship word or a particle ("Big Al" is not enough). */
const NOT_A_NAME_WORD = new Set([...KIN, ...NAME_PARTICLES, "and", "the", "of", "al", "el"]);
/** Everyday words and months: a name made only of them ("Holly Berry", "Rose Hill") is matched only as a name is written. */
const EVERYDAY_WORDS = new Set([...EVERYDAY, ...COMMON_WORD_NAMES].filter((w) => !KIN.has(w)));
const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
/** Words that put a month (or an everyday word) in a date rather than a person in a sentence: "in May", "last May". */
const DATE_BEFORE = new Set(["in", "on", "by", "since", "until", "till", "early", "late", "mid", "last", "next", "this", "of", "from", "through"]);
/** Words that put a place, not a person, after them: "a train to Florence", "back in Georgia". */
const PLACE_BEFORE = new Set(["to", "in", "from", "near", "at", "visiting", "visit", "around", "through", "via", "into", "toward", "towards", "outside", "downtown", "across", "of"]);

/** Whether a name word is a title or kinship word ("Great-Aunt" as much as "Aunt"). */
function isKin(word: string): boolean {
  return bare(word).split(/[-‐]/).every((p) => KIN.has(p));
}

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

/** A word as names are compared: accents off, periods and commas off, lower case ("Zoë" is "zoe"). */
function bare(word: string) {
  return unaccented(word).replace(/[.,]/g, "").toLowerCase();
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

/**
 * A title in title case ("Grace Swimming At The Lake"): capitals there say nothing about names. Judged on the words
 * that are not the person's own name, which are capitalized anyway.
 */
function titleCase(text: string, own: Set<string>): boolean {
  const words = (text.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? []).filter((w) => letters(w) >= 2 && !own.has(bare(w)));
  if (words.length < 2) return false;
  return words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

/** At the start of the text, of a line, or of a sentence — after any opening quote, bracket or markdown. */
function startsSentence(before: string): boolean {
  const lead = before.match(/[\s"'“‘(\[*_#>\-–—•]*$/u)?.[0] ?? "";
  const rest = before.slice(0, before.length - lead.length);
  return rest === "" || lead.includes("\n") || /[.!?…]["'”’)\]]*$/u.test(rest);
}

/** Words that put a place after them in the text the helper writes: "a trip to Florence", "the Duomo in Florence". */
const PLACE_NEAR = new Set(["to", "in", "from", "near", "at", "visiting", "visit", "via", "into", "toward", "towards", "through", "across", "around"]);
/** Words after "May" that make it the day or the pole, not her. */
const DAY_AFTER = new Set(["day", "days", "pole", "poles", "queen", "fair", "fayre", "time"]);

/** The words either side of a match: only words next to it on the same line, and nothing before a sentence start. */
function neighbours(before: string, after: string) {
  // "…to Maine. Ada swam": "Maine." ends a sentence, and is no neighbour of hers; "J. Ada" is an initial and is.
  const sentence = startsSentence(before) && !/(?<![\p{L}\p{M}])\p{L}\.[ \t]*$/u.test(before);
  const prev = sentence ? null : (before.match(/([\p{L}\p{M}'’.-]+)[ \t]+$/u)?.[1] ?? null);
  const next = after.match(/^[ \t]+([\p{L}\p{M}'’-]+)/u)?.[1] ?? null;
  return { prev, next, possessive: /^['’]s(?![\p{L}\p{M}])/u.test(after) };
}

/** "Florence, Italy", "Paris, TX": a place, then the larger place it is in. */
const PLACE_COMMA = /^,[ \t]*(\p{Lu}[\p{L}\p{M}'’.-]*)/u;

export type Neighbourhood = {
  /** Words of other people's names (not theirs): beside one, a match is that person ("Ada Lovelace"). */
  otherWords?: Set<string>;
  /** In a title written in title case, capitals say nothing about names. */
  title?: boolean;
  /** Whether it may be a date: after "in", "last", "by"; before a number; "May Day", "MAY DAY". */
  date?: boolean;
  /**
   * Whether it may be a place: "wide" after any word that puts one after it ("to", "in", "of"), "near" after the
   * few that usually do ("to", "in", "from", "near", "at", "visiting"), "comma" only where it is written as one
   * ("to Florence, Italy", "Florence, Italy").
   */
  place?: "wide" | "near" | "comma" | "none";
  /** Directly before a number: "Florence 2019". */
  number?: boolean;
  /** Words of their own name: beside one, a match is still them ("Mary Ann swam" for Mary Ann Smith). */
  own?: Set<string>;
  /** Whether a word is somebody's name the album knows: "Left to right: Ada, Ben" is no place and its region. */
  isNameWord?: (word: string) => boolean;
};

/**
 * Whether the words around a match of a short name (or a name made of everyday words) say it is somebody or
 * something else: "Ann Jones" and "Mary Ann" (another capitalized word beside it, unless the one before only says
 * when, "On Sunday Grace", or who she is to them, "Aunt Grace"), "Union Jack", "Robin Hood", "a trip to Florence",
 * "Florence, Italy", "in June", "May 2019". One judgement for everything that looks for names: the scrub here, and the
 * forgotten names in tombstone.ts.
 */
export function notThePerson(text: string, start: number, end: number, n: Neighbourhood = {}): boolean {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const match = text.slice(start, end);
  const { prev, next, possessive } = neighbours(before, after);
  const p = prev ? bare(prev.replace(/\.$/u, "")) : null;
  if (n.otherWords && ((p && n.otherWords.has(p)) || (next && n.otherWords.has(bare(next))))) return true;
  if (n.date) {
    // "by May's side" is her.
    if (p && DATE_BEFORE.has(p) && !(p === "by" && possessive)) return true;
    if (/^[\s,]*\d/u.test(after)) return true;
    if (next && DAY_AFTER.has(bare(next))) return true;
    if (next && isUpperWord(match.replace(/[^\p{L}]/gu, "")) && isUpperWord(next)) return true;
  }
  if (n.number && /^[ \t]+\d/u.test(after)) return true;
  // Only a place the album knows is one ("a train to Florence", "Florence, Italy"); anybody else after "to" or "at"
  // is a person: "waving to Ximena".
  const place = n.place ?? "none";
  if (place !== "none" && PLACE_NAMES.has(bare(match).replace(/[-‐]/g, " "))) {
    const words = place === "wide" ? PLACE_BEFORE : PLACE_NEAR;
    const afterPlaceWord = Boolean(p && words.has(p) && !possessive);
    const region = after.match(PLACE_COMMA)?.[1] ?? null;
    const comma = Boolean(region && !n.own?.has(bare(region)) && !n.isNameWord?.(region));
    if (comma) return true;
    if (place !== "comma" && afterPlaceWord) return true;
  }
  const caps = isUpperWord(match.replace(/[^\p{L}]/gu, ""));
  if (!n.title && !caps) {
    // "Ann Jones", "Robin Hood", "Florence Nightingale" (but "Mary Ann swam" is Mary Ann Smith)...
    if (next && /^\p{Lu}/u.test(next) && !n.own?.has(bare(next))) return true;
    // ..."Mary Ann" and "Union Jack", unless the word before only says when or who she is to them.
    if (prev && /^\p{Lu}/u.test(prev) && !isKin(prev.replace(/\.$/u, "")) && !STARTERS.has(p!) && !n.own?.has(p!)) return true;
  }
  return false;
}

const WHEN_WORDS = new Set([...MONTHS, ...DATE_BEFORE, "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "spring", "summer", "autumn", "fall", "winter", "christmas", "easter", "today", "yesterday"]);

/** Whether a keyword beside a name makes it a place or a date: "florence duomo italy", "may 2019". */
export function isPlaceOrDateWord(word: string): boolean {
  const w = bare(word);
  return /^\d/u.test(w) || PLACE_NAMES.has(w) || WHEN_WORDS.has(w);
}

/** Whether a word is an everyday word or a month ("may", "grace", "summer"): a name made of them is written as one. */
export function isEverydayWord(word: string): boolean {
  return EVERYDAY_WORDS.has(bare(word));
}

/** Whether a text reads as a title in title case, judged without these words (the name looked for). */
export function inTitleCase(text: string, own: string[] = []): boolean {
  return titleCase(text, new Set(own.map(bare)));
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

/**
 * Replace these spans of a text (sorted, not overlapping) with the stand-in, capitalized as a name found there would
 * be: at a sentence start, in a title-case title, or in capitals among capitals.
 */
export function replaceSpans(text: string, spans: [number, number][]): string {
  if (!spans.length) return text;
  // Judged on the words around the names, not the names, which are capitalized anyway: "Trip: Ada Byron, 2019" is
  // no title in title case.
  let rest = "";
  let from = 0;
  for (const [a, b] of spans) {
    rest += `${text.slice(from, a)} `;
    from = b;
  }
  const title = titleCase(rest + text.slice(from), new Set());
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    const m = text.slice(a, b);
    const s = standIn(m, text.slice(0, a), text.slice(b));
    out += text.slice(at, a) + (title && s !== STAND_IN.toUpperCase() ? "A Family Member" : s);
    at = b;
  }
  return withoutDoubledArticle(out + text.slice(at));
}

/**
 * "a a family member", "the a family member": the article in front of a name that was taken out goes with it.
 */
export function withoutDoubledArticle(text: string): string {
  return text.replace(/(?<![\p{L}\p{M}\p{N}])(a|an|the)\s+(a family member)/giu, (_m: string, art: string, stand: string) => {
    if (stand === STAND_IN.toUpperCase()) return stand;
    if (stand === "A Family Member") return stand;
    return /^\p{Lu}/u.test(art) ? STAND_IN[0].toUpperCase() + STAND_IN.slice(1) : STAND_IN;
  });
}

/** How names are compared once hashed: accents off, lower case, periods off, hyphens as spaces, one apostrophe. */
export function normalizeName(s: string): string {
  return unaccented(s.normalize("NFC")).toLowerCase().replace(/’/g, "'").replace(/[-‐]/g, " ").replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/**
 * Where a text is. `tagged`: on one of the person's own photographs (tagged, or once tagged), or a text about one.
 * `others`: the names of the other people tagged on that photograph, whose words are theirs there, not this person's.
 */
export type Where = {
  tagged?: boolean;
  others?: string[];
  /**
   * Away from their photographs, only their full names — never a first name, however unusual. For somebody who is
   * merely not to be named (not forgotten): a first name alone on somebody else's photograph identifies nobody, and
   * is as often a place in a member's title ("Florence and Tuscany 2019").
   */
  fullOnly?: boolean;
};

export type NameMatcher = {
  /** Prose with every mention replaced by "a family member"; anything that is not a string comes back as it was. */
  scrub<T>(text: T, where?: Where): T;
  /**
   * Keyword text (the helper's search summary): on the person's own photographs any word of their name counts, in
   * any case — "ada birthday cake" is about Ada there — and elsewhere the rules for prose.
   */
  scrubKeywords<T>(text: T, where?: Where): T;
  /** Whether prose mentions them, by exactly the same rules. */
  mentions(text: unknown, where?: Where): boolean;
  /** Whether a tag or object is about them (see `scrubKeywords`). */
  namesTag(tag: unknown, where?: Where): boolean;
  /** Spellings safe to look for anywhere in the album, for a database pre-filter; empty when there are none. */
  albumForms: string[];
  /**
   * What is remembered of them once they are forgotten (hashed, see tombstone.ts): their full names, and a one-word
   * name that is all of their name and could be nobody's word — never a first name taken from a full one, and never
   * "June", "Grace" or "Will" (their own photographs were scrubbed when they were forgotten). A full name of everyday
   * words, and every one-word name, only as a name is written: "Sage", not "sage green".
   */
  tombstoneForms: { form: string; capitalizedOnly: boolean }[];
};

/** `whole`: all of their name ("Florence"), not the first name of a full one ("Florence" of Florence Adams). */
type Short = { form: string; word: string; everyday: boolean; whole?: boolean };

/**
 * A matcher for one person: every name they have gone by (`names`), and the names of everybody else the album
 * knows (`others`), which decide whether a short name of theirs is theirs alone.
 *
 * On the person's own photographs, their first name is always theirs (capitalized, in prose): "Jack", "Grace", and
 * "Ada" though another Ada exists — unless somebody else tagged on the same photograph shares it. There, too, every
 * word of their name counts in the helper's keywords, in any case, surname included. Away from their photographs
 * only what could be nobody else is used: a full name, or a first or one-word name that is safe.
 */
export function nameMatcher(names: string[], others: string[] = []): NameMatcher {
  const list = (Array.isArray(names) ? names : []).filter((n): n is string => typeof n === "string" && n.trim() !== "");
  const otherNames = (Array.isArray(others) ? others : []).filter((o): o is string => typeof o === "string" && o.trim() !== "");
  const own = new Set(list.flatMap((n) => wordsOf(splitNickname(n).name).map(bare)));
  const theirs = otherNames.flatMap((o) => wordsOf(splitNickname(o).name).map(bare));
  // Any word of anybody else's name makes a short name of theirs ambiguous away from their photographs; beside a
  // match, only words not also theirs say it is somebody else ("Lovelace" beside "Ada", not "Byron").
  const shared = new Set(theirs);
  const otherWords = new Set(theirs.filter((w) => !own.has(w)));

  const longAny: string[] = []; // any case, anywhere
  const longCap: string[] = []; // as written, anywhere: full names made of everyday words
  const longTagged: string[] = []; // as written, their photographs only: "Big Al"
  const safe: Short[] = []; // as written, anywhere
  const whole: string[] = []; // a safe short name that is all of their name ("Sam", "Grandma Ruth"'s "Ruth")
  const taggedOnly: Short[] = []; // as written, their photographs only
  const strong = new Set<string>(); // any case, in keywords on their photographs: a first name that is no word
  const weak = new Set<string>(); // in keywords only as the whole tag, or beside another word of the name
  const oneWord: string[] = []; // a one-word name that is all of their name, for the tombstone
  const cjkAlbum: string[] = [];
  const cjkTagged: string[] = [];
  const capitalized = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const addShort = (w: string, isWhole: boolean) => {
    const word = bare(w);
    if (letters(w) < 2 || isKin(w)) return;
    const short = { form: capitalized(w), word, everyday: EVERYDAY_WORDS.has(word), whole: isWhole };
    if (letters(w) >= 3 && !NOT_SAFE.has(word) && !shared.has(word)) {
      safe.push(short);
      if (isWhole) whole.push(w);
    } else taggedOnly.push(short);
  };
  /** A first name of two words ("Mary Ann"): theirs anywhere unless either word is an everyday one. */
  const addPair = (a: string, b: string) => {
    if (letters(a) < 2 || letters(b) < 2 || isKin(a) || isKin(b) || NOT_A_NAME_WORD.has(bare(b))) return;
    const short = { form: `${capitalized(a)} ${capitalized(b)}`, word: `${bare(a)} ${bare(b)}`, everyday: false };
    if ([a, b].some((w) => NOT_SAFE.has(bare(w)))) taggedOnly.push(short);
    else safe.push(short);
  };
  for (const n of list) {
    const { name, nicknames } = splitNickname(n.trim().replace(/\s+/g, " "));
    for (const [ni, s] of [name, ...nicknames].entries()) {
      if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
      // "Nan" in "Ann (Nan) Smith": a kinship word, but what the family calls her — on her own photographs.
      if (ni > 0 && !s.includes(" ") && isKin(s) && letters(s) >= 2) {
        taggedOnly.push({ form: capitalized(s), word: bare(s), everyday: false });
        weak.add(s);
        continue;
      }
      if (CJK.test(s)) {
        const compact = s.replace(/\s+/g, "");
        // Several parts, or three characters that are not only kana, can only be a name; "さくら" and "春花" are
        // words too, and are hers only on her own photographs.
        const album = s.includes(" ") || ([...compact].length >= 3 && !/^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(compact));
        if (album) cjkAlbum.push(s);
        else if ([...compact].length >= 2) cjkTagged.push(s);
        continue;
      }
      const tokens = s.split(" ");
      // "Grandma Ruth" is Ruth, and "Dr. Ed Jones" is Ed Jones.
      let k = 0;
      while (k < tokens.length - 1 && isKin(tokens[k])) k++;
      const core = tokens.slice(k);
      // "June", "Grace", "Will": remembered, they would take every month and every question with them.
      if (ni === 0 && tokens.length === 1 && letters(s) >= 3 && !isKin(s) && !NOT_SAFE.has(bare(s)) && !MONTHS.has(bare(s))) oneWord.push(s);
      // In keywords, a first name that is no everyday word counts on its own; a surname, a middle name or an
      // everyday word ("grace", "byron bay", "wood fire") only as the whole tag or beside another word of the name.
      core.forEach((w, i) => {
        if (letters(w) < 2 || NOT_A_NAME_WORD.has(bare(w))) return;
        for (const part of [w, ...w.split(/[-‐]/)]) {
          if (letters(part) < 2 || isKin(part)) continue;
          if (i === 0 && !EVERYDAY_WORDS.has(bare(part)) && !NOT_SAFE.has(bare(part))) strong.add(part);
          else weak.add(part);
        }
      });
      // "Mary Ann Smith" is also "Mary Smith"; and "Mary Ann", written as a name, is her first name (below).
      const firstLast = core.length >= 3 ? `${core[0]} ${core[core.length - 1]}` : null;
      const fulls = [...new Set([tokens.length >= 2 ? s : null, core.length >= 2 ? core.join(" ") : null, firstLast].filter((f): f is string => Boolean(f)))];
      for (const f of fulls) {
        const ws = f.split(" ");
        if (!ws.some((w) => letters(w) >= 2 && !NOT_A_NAME_WORD.has(bare(w)))) longTagged.push(ws.map(capitalized).join(" "));
        else if (ws.every((w) => isKin(w) || EVERYDAY_WORDS.has(bare(w)) || NOT_A_NAME_WORD.has(bare(w)))) longCap.push(ws.map(capitalized).join(" "));
        else longAny.push(f);
      }
      addShort(core[0], core.length === 1);
      if (core.length >= 3) addPair(core[0], core[1]);
    }
  }
  const variants = (forms: string[]) => [...new Set(forms.flatMap((f) => [f.normalize("NFC"), f.normalize("NFD"), unaccented(f)]))].sort((a, b) => b.length - a.length);
  const withCaps = (forms: string[]) => variants(forms).flatMap((f) => [f, f.toUpperCase()]);
  const rx = (source: string, flags: string) => (source ? new RegExp(source, flags) : null);
  const longAnyRx = rx(bounded(variants(longAny)), "giu");
  const longAnyTest = rx(bounded(variants(longAny)), "iu");
  const longCapRx = rx(bounded(withCaps(longCap)), "gu");
  const wholeTest = rx(bounded(variants(whole)), "iu");
  const wholeRx = rx(bounded(variants(whole)), "giu");
  const cjkBodies = (forms: string[]) => [...new Set(forms)].sort((a, b) => b.length - a.length).map(cjkBody).join("|");
  const cjkAlbumRx = rx(cjkBodies(cjkAlbum), "gu");
  const cjkAllRx = rx(cjkBodies([...cjkAlbum, ...cjkTagged]), "gu");
  // Somebody else's name that contains one of theirs: "花子" is not forgotten inside "山田花子".
  const cjkCompact = [...cjkAlbum, ...cjkTagged].map((f) => f.replace(/\s+/g, ""));
  const cjkOthers = otherNames.filter((o) => CJK.test(o) && cjkCompact.some((f) => o.replace(/\s+/g, "").includes(f) && o.replace(/\s+/g, "") !== f));
  const cjkOthersRx = rx(cjkBodies(cjkOthers), "gu");
  const safeByForm = new Map(safe.map((x) => [x.form, x]));

  /** The short names in play for one text, and what each is. */
  const shortsFor = (where: Where) => {
    const there = new Set((where.others ?? []).flatMap((o) => wordsOf(splitNickname(o).name).map(bare)));
    const extra = where.tagged ? taggedOnly.filter((x) => !there.has(x.word)) : [];
    const all = [...(where.tagged || !where.fullOnly ? safe : []), ...extra];
    const byForm = new Map<string, Short>([...all.map((x) => [x.form, x] as const)]);
    return { rx: rx(bounded(withCaps(all.map((x) => x.form))), "gu"), byForm, there, tagged: new Set(extra.map((x) => x.word)) };
  };

  const standInFor = (m: string, before: string, after: string, title: boolean) => {
    const out = standIn(m, before, after);
    // In a title written in title case, the stand-in is too: "A Family Member At The Lake".
    return title && out !== STAND_IN.toUpperCase() ? "A Family Member" : out;
  };

  const scrubText = (text: string, where: Where): string => {
    const title = titleCase(text, own);
    const put = (m: string, offset: number, whole: string) => standInFor(m, whole.slice(0, offset), whole.slice(offset + m.length), title);
    let out = longAnyRx ? text.replace(longAnyRx, put) : text;
    if (longCapRx) out = out.replace(longCapRx, put);
    if (where.tagged && longTagged.length) {
      const r = rx(bounded(withCaps(longTagged)), "gu");
      if (r) out = out.replace(r, put);
    }
    const cjkRx = where.tagged ? cjkAllRx : cjkAlbumRx;
    if (cjkRx) {
      const inside: [number, number][] = [];
      if (cjkOthersRx) for (const o of out.matchAll(cjkOthersRx)) inside.push([o.index!, o.index! + o[0].length]);
      out = out.replace(cjkRx, (m: string, offset: number, whole: string) => (inside.some(([a, b]) => offset >= a && offset + m.length <= b) ? m : put(m, offset, whole)));
    }
    const shorts = shortsFor(where);
    if (shorts.rx) {
      out = out.replace(shorts.rx, (m: string, offset: number, whole: string) => {
        const short = shorts.byForm.get(m) ?? [...shorts.byForm.values()].find((x) => bare(x.form) === bare(m)) ?? safeByForm.get(m);
        const everyday = Boolean(short?.everyday && shorts.tagged.has(short.word));
        const somebodyElse = notThePerson(whole, offset, offset + m.length, {
          otherWords,
          own,
          isNameWord: (w) => shared.has(bare(w)) || own.has(bare(w)),
          title,
          // A month or an everyday word in a date, on their own photographs: "in May", "May 5", "May Day".
          date: everyday,
          // Away from their photographs a first name that is also a place is one after "to", "in", "near" ("to
          // Florence"), and one before a number is a date or a thing ("Florence 2019"); on them, only a place written
          // as one ("Florence, Italy").
          // A first name taken from a full one is the place after "to" even there ("We flew to Florence.").
          place: !where.tagged ? "wide" : short?.whole ? "comma" : "near",
          number: !where.tagged,
        });
        return somebodyElse ? m : standInFor(m, whole.slice(0, offset), whole.slice(offset + m.length), title);
      });
    }
    return out === text ? out : withoutDoubledArticle(out);
  };

  /** Name words in keywords, on their own photographs; not a word somebody else tagged there shares. */
  const keywordsFor = (where: Where) => {
    if (!where.tagged) return { strongRx: null, pairRx: null, weakWords: [] as string[] };
    const there = new Set((where.others ?? []).flatMap((o) => wordsOf(splitNickname(o).name).map(bare)));
    const s = [...strong].filter((w) => !there.has(bare(w)));
    const all = [...new Set([...strong, ...weak])].filter((w) => !there.has(bare(w)));
    // Two words of the name side by side ("byron ada", "grace hopper") are her, whatever each is on its own.
    const pairs = all.flatMap((a) => all.filter((b) => b !== a).map((b) => `${a} ${b}`));
    return { strongRx: rx(bounded(variants(s)), "giu"), pairRx: rx(bounded(variants(pairs)), "giu"), weakWords: all.map((w) => bare(w)) };
  };

  const guard = <T,>(text: T, f: (t: string) => string): T => {
    if (typeof text !== "string" || !text) return text;
    try {
      return f(text) as T;
    } catch {
      return text;
    }
  };
  const scrub = <T,>(text: T, where: Where = {}): T => guard(text, (t) => scrubText(t, where));
  const scrubKeywords = <T,>(text: T, where: Where = {}): T =>
    guard(text, (t) => {
      const put = (m: string, offset: number, w: string) => standIn(m, w.slice(0, offset), w.slice(offset + m.length));
      let out = scrubText(t, where);
      const k = keywordsFor(where);
      if (k.pairRx) out = out.replace(k.pairRx, put);
      if (k.strongRx) out = out.replace(k.strongRx, put);
      // A one-word name that is all of theirs is them in lower case too, anywhere: "ximena fishing".
      if (wholeRx) out = out.replace(wholeRx, put);
      return out === t ? out : withoutDoubledArticle(out);
    });
  const mentions = (text: unknown, where: Where = {}) => typeof text === "string" && text !== "" && scrub(text, where) !== text;
  const namesTag = (tag: unknown, where: Where = {}) => {
    if (typeof tag !== "string" || !tag.trim()) return false;
    try {
      const t = tag.trim().toLowerCase().replace(/’/g, "'");
      const k = keywordsFor(where);
      if (k.strongRx && new RegExp(k.strongRx.source, "iu").test(tag)) return true;
      if (k.pairRx && new RegExp(k.pairRx.source, "iu").test(tag)) return true;
      const bareTag = bare(t.replace(/'s$/u, ""));
      if (k.weakWords.includes(bareTag)) return true;
      if ((where.tagged ? [...cjkAlbum, ...cjkTagged] : cjkAlbum).some((f) => t.replace(/\s+/g, "").includes(f.replace(/\s+/g, "")))) return true;
      if (safe.some((x) => t === x.form.toLowerCase() || t === `${x.form.toLowerCase()}'s`)) return true;
      // A safe one-word name is all of their name: a tag containing it ("sam's bike") is about them.
      return Boolean(wholeTest?.test(tag) || longAnyTest?.test(tag));
    } catch {
      return false;
    }
  };
  // A pre-filter needs something long enough to be selective: "Al" would match every other row.
  const albumForms = [...variants(longAny), ...variants(longCap), ...variants(whole)].filter((f) => letters(f) >= 3);
  return {
    scrub,
    scrubKeywords,
    mentions,
    namesTag,
    albumForms: [...new Set([...albumForms, ...cjkAlbum])],
    tombstoneForms: [
      ...longAny.map((form) => ({ form, capitalizedOnly: false })),
      ...longCap.map((form) => ({ form, capitalizedOnly: true })),
      ...oneWord.map((form) => ({ form, capitalizedOnly: true })),
      ...cjkAlbum.map((form) => ({ form, capitalizedOnly: false })),
    ],
  };
}

/**
 * The helper's record with the name taken out of every piece of prose, the keywords of its search summary, and every
 * tag or object naming them dropped: "ada" or "ada's birthday" is only there to find her. A malformed record (a
 * missing list, a number where text was expected) comes back well-formed rather than throwing.
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
    searchSummary: typeof a.searchSummary === "string" ? m.scrubKeywords(a.searchSummary, where) : "",
    place: maybe(a.place),
    activity: maybe(a.activity),
    visibleText: maybe(a.visibleText),
    mood: maybe(a.mood),
    tags: list(a.tags),
    objects: list(a.objects),
  };
}

/** Whether any prose field of the helper's record, its search summary, or any tag or object, mentions them. */
export function annotationMentions(a: unknown, m: NameMatcher, where: Where = {}): boolean {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  const summary = typeof r.searchSummary === "string" && m.scrubKeywords(r.searchSummary, where) !== r.searchSummary;
  return summary || ["title", "caption", "description", "place", "activity", "visibleText", "mood"].some((k) => m.mentions(r[k], where)) || [r.tags, r.objects].some((l) => Array.isArray(l) && l.some((t) => m.namesTag(t, where)));
}
