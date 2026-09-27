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
  "great", "grand", "aunt", "auntie", "aunty", "uncle", "cousin", "mom", "mum", "mother", "dad", "father", "sister", "brother", "sis", "bro", "son", "daughter", "half",
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
  "visiting", "visited", "visit", "so", "as", "since", "meanwhile", "finally", "also", "even", "only", "just", "maybe", "perhaps", "dear", "happy", "love", "hi", "hello", "thanks", "by",
  "for", "from", "to", "of", "into", "is", "was", "the", "a", "an", "this", "that", "look", "see", "meet", "oh", "yes", "no", "our", "my", "little", "baby",
]);

/**
 * Words that join a title's words rather than name anybody: "Ximena At The Hut", "Ximena And Ben", "Ximena Beside
 * The Lake". Beside a name, capitalized or not, they never make it somebody else's; a name-like word does ("Santa
 * Barbara", "Leo Martinez", "Lake Louise").
 */
/** A saint's title just before a name, which away from their photographs makes it a place's ("St. Mary's Church"). */
const SAINT_BEFORE = /(?<![\p{L}\p{M}])(?:st|ste|saint|san|santa|sankt)\.?[ \t]+$/iu;

/** Nouns of places named "X Of Somebody": "Isle Of Barbara", "Church Of St Barbara", "Bay Of Louise". */
const PLACE_OF = new Set([
  "isle", "island", "bay", "port", "lake", "loch", "mount", "cape", "gulf", "sound", "strait", "church", "cathedral", "chapel", "basilica", "abbey",
  "priory", "parish", "house", "castle", "palace", "hall", "fort", "tower", "bridge", "gate", "street", "square", "school", "college", "university",
  "hospital", "county", "city", "town", "village", "valley", "river", "park",
]);

export const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "&", "at", "in", "on", "with", "without", "within", "by", "beside", "besides", "near", "to", "for", "from",
  "under", "over", "into", "onto", "upon", "up", "down", "off", "out", "after", "before", "behind", "across", "around", "along", "among", "through", "past",
  "during", "outside", "inside", "towards", "toward", "against", "via", "vs", "as", "her", "his", "their", "our", "my", "your", "its", "is", "was", "are", "were",
  "be", "s", "has", "had",
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
/** Sayings in capitals whatever the sentence around them ("Singing Amazing Grace"), left out of judging title case. */
const IDIOM_WORDS = /(?<![\p{L}\p{M}])(?:Amazing[ \t]+Grace|Uncle[ \t]+Sam|Book[ \t]+of[ \t]+Ruth|Jack[ \t]+in[ \t]+the[ \t]+Box)(?![\p{L}\p{M}])/giu;

function titleCase(text: string, own: Set<string>): boolean {
  text = text.replace(IDIOM_WORDS, " ");
  const words = (text.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? []).filter((w) => letters(w) >= 2 && !own.has(bare(w)));
  if (words.length < 2) return false;
  return words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

/** The sentence (or line) around a place in a text: title case is judged there, not over the whole text. */
function sentenceAt(text: string, at: number): [number, number] {
  let a = at;
  while (a > 0 && text[a - 1] !== "\n" && !(/\s/u.test(text[a - 1]) && /[.!?…]/u.test(text[a - 2] ?? ""))) a--;
  let b = at;
  while (b < text.length && text[b] !== "\n") {
    if (/[.!?…]/u.test(text[b]) && (b + 1 >= text.length || /\s/u.test(text[b + 1]))) {
      b++;
      break;
    }
    b++;
  }
  return [a, b];
}

/** Whether the sentence around `at` reads as a title in title case, without these words (the names looked for). */
function titleCaseAt(text: string, at: number, own: Set<string>): boolean {
  const [a, b] = sentenceAt(text, at);
  // Two capitalized words are no title of their own ("The Union Jack."): a sentence that short is judged with the text.
  const words = (text.slice(a, b).replace(IDIOM_WORDS, " ").match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? []).filter((w) => letters(w) >= 2 && !own.has(bare(w)));
  return words.length >= 3 ? titleCase(text.slice(a, b), own) : words.length === 0 ? false : titleCase(text, own) && titleCase(text.slice(a, b), own);
}

/** At the start of the text, of a line, or of a sentence — after any opening quote, bracket or markdown. */
function startsSentence(before: string): boolean {
  const lead = before.match(/[\s"'“‘(\[*_#>\-–—•]*$/u)?.[0] ?? "";
  const rest = before.slice(0, before.length - lead.length);
  return rest === "" || lead.includes("\n") || /[.!?…]["'”’)\]]*$/u.test(rest);
}

/** Words that put a place after them in the text the helper writes: "a trip to Florence", "the Duomo in Florence". */
const PLACE_NEAR = new Set(["to", "in", "from", "near", "at", "visiting", "visit", "via", "into", "toward", "towards", "through", "across", "around", "of"]);
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

/**
 * What follows a place that opens a sentence or a title: "Florence in spring", "Florence and Tuscany 2019",
 * "Florence, Italy", "Trip: Florence". A person there does something ("Florence waved").
 */
const PLACE_OPENING = /^(?:[ \t]*$|[ \t]*[\n,;:.!?)\]–—-]|[ \t]+(?:and|in|of|at|near|from|to|by|trip|trips|holiday|holidays|vacation|visit|getaway|weekend|skyline|streets|sunset|sunrise|at\s+night|\d)(?![\p{L}\p{M}]))/iu;

/**
 * On the person's own photographs a name opening a sentence is them unless a place is plainly meant: "Florence
 * trip", "Florence 2019", or "Florence, Italy" (judged apart). "Charlotte" alone as a title there is her.
 */
const PLACE_OPENING_CLEAR = /^[ \t]+(?:trip|trips|holiday|holidays|vacation|visit|getaway|weekend|skyline|\d)(?![\p{L}\p{M}])/iu;

/** Going somewhere: "flew to", "drove from", "visiting", "a trip to", "the road to". */
const TRANSPORT = "flew|fly|flying|flies|drove|drive|driving|train|trains|flight|flights|ferry|bus|road[ \\t]+trip|sailed|sail|sailing|cruise|cruised|cruising";
/** Going there by some means: "flew to", "drove from", "the train to", "a road trip to". */
const TRAVEL_BEFORE = new RegExp(`(?<![\\p{L}\\p{M}])(?:${TRANSPORT})[ \\t]+(?:to|from|into)[ \\t]+$`, "iu");
/** Another place the album knows joined to it ("Charlotte and Raleigh"); checked word by word below. */
const JOINED_PLACE_AFTER = {
  test: (after: string) => {
    const w = after.match(/^[ \t]+(?:and|&|or|vs\.?|to)[ \t]+(\p{Lu}[\p{L}\p{M}'’.-]*)/u)?.[1];
    return Boolean(w && PLACE_NAMES.has(bare(w)));
  },
};
/** Visiting a place, which counts only with a clear place after it ("visited Florence, Italy", "visiting Florence 2019"). */
const VISIT_BEFORE = /(?<![\p{L}\p{M}])(?:visit|visits|visited|visiting)[ \t]+$/iu;
/** Staying or arriving somewhere, earlier in the sentence than "in <place>": "we stayed a week in Florence." */
const STAY_BEFORE = new RegExp(`(?<![\\p{L}\\p{M}])(?:stayed|staying|stay|stays|arrived|arriving|arrive|lived|living|live|holiday|holidays|vacation|honeymoon|${TRANSPORT})(?![\\p{L}\\p{M}])[^.!?\\n]*(?<![\\p{L}\\p{M}])in[ \\t]+$`, "iu");

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
  place?: "wide" | "near" | "comma" | "travel" | "none";
  /** Directly before a number: "Florence 2019". */
  number?: boolean;
  /** Words of their own name: beside one, a match is still them ("Mary Ann swam" for Mary Ann Smith). */
  own?: Set<string>;
  /**
   * Away from their photographs (Where.away): beside another capitalized word a match is somebody else's name
   * or a place's however the text is written, in title case or all in capitals ("SANTA BARBARA PIER").
   */
  away?: boolean;
  /**
   * Their own photographs (or a forgotten name's own scope): a place opening a sentence only where it is plainly
   * one, so "Florence at the lake" and "Florence and Ben swam." are her.
   */
  ownPhotos?: boolean;
  /**
   * "clear": a place opening a sentence only where plainly one ("Florence 2019", "Florence trip"), as on their own
   * photographs, without their other allowances: for photographs a note of theirs names them on.
   */
  opening?: "clear" | "wide";
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
  if (isIdiom(before, match, after, Boolean(n.ownPhotos))) return true;
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
    if ((place === "wide" || place === "near") && afterPlaceWord) return true;
    // On their own photographs their name is the place only where somebody plainly goes or stays there: "We flew to
    // Charlotte", "visiting Charlotte 2019", "we stayed in Charlotte." ("Ben ran back to Madison", "Ben leaned in
    // Madison" and "Ben visited Madison in hospital" are her).
    if (place === "travel" && !possessive) {
      if (TRAVEL_BEFORE.test(before)) return true;
      if (VISIT_BEFORE.test(before) && (PLACE_OPENING_CLEAR.test(after) || JOINED_PLACE_AFTER.test(after))) return true;
      if (p === "in" && (PLACE_OPENING_CLEAR.test(after) || (/^[ \t]*(?:$|[\n.!?;,])/u.test(after) && STAY_BEFORE.test(before)))) return true;
    }
    // "Atlanta, Georgia": the region after a city the album knows.
    const city = before.match(/(\p{Lu}[\p{L}\p{M}'’.-]*),[ \t]*$/u)?.[1] ?? null;
    if (city && PLACE_NAMES.has(bare(city)) && !n.own?.has(bare(city)) && !n.isNameWord?.(city)) return true;
    // Opening a sentence or a title ("Trip: Florence"), with nothing after it that a person would do.
    const opening = startsSentence(before) || /:[ \t]*$/u.test(before);
    // ("Left to right: Florence, Ben." lists people.)
    if (opening && !possessive && !(region && !comma)) {
      if (n.ownPhotos || n.opening === "clear" ? PLACE_OPENING_CLEAR.test(after) : PLACE_OPENING.test(after)) return true;
    }
  }
  const caps = isUpperWord(match.replace(/[^\p{L}]/gu, ""));
  // Away from their own photographs a saint's name is a place's, never a title before theirs: "St Mary's Church",
  // "Christening at St. Mary's church", "Saint Peter's Basilica". Read from the text itself, so "St." is not taken
  // for the end of a sentence.
  if (!n.ownPhotos && SAINT_BEFORE.test(before)) return true;
  if (n.away) {
    // "Isle Of Barbara", "Church Of Barbara": a place's noun and "Of" before it make it the place's name ("Of" is no
    // joining word). Only a place's noun: "Portrait Of Barbara", "The Wedding Of Barbara And Ben" are her.
    const of = before.match(/(?<![\p{L}\p{M}])(\p{Lu}[\p{L}\p{M}'’-]*)[ \t]+of[ \t]+$/iu);
    if (of && PLACE_OF.has(bare(of[1]))) return true;
  }
  if (n.away || (!n.title && !caps)) {
    // "Ann Jones", "Robin Hood", "Florence Nightingale" (but "Mary Ann swam" is Mary Ann Smith)...
    if (next && /^\p{Lu}/u.test(next) && !n.own?.has(bare(next)) && !FUNCTION_WORDS.has(bare(next))) return true;
    // ..."Mary Ann" and "Union Jack", unless the word before only says when or who she is to them.
    if (prev && /^\p{Lu}/u.test(prev) && !isKin(prev.replace(/\.$/u, "")) && !STARTERS.has(p!) && !FUNCTION_WORDS.has(p!) && !n.own?.has(p!)) return true;
  }
  return false;
}

const WHEN_WORDS = new Set([...MONTHS, ...DATE_BEFORE, "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "spring", "summer", "autumn", "fall", "winter", "christmas", "easter", "today", "yesterday"]);

/** Whether a name is a single word that is also a place the album knows ("Florence", "Georgia"). */
export function isListedPlace(name: string): boolean {
  const words = wordsOf(splitNickname(name).name);
  return words.length === 1 && PLACE_NAMES.has(bare(words[0]));
}

/** Whether a keyword beside a name makes it a place or a date: "florence duomo italy", "may 2019". */
export function isPlaceOrDateWord(word: string): boolean {
  const w = bare(word);
  return /^\d/u.test(w) || PLACE_NAMES.has(w) || WHEN_WORDS.has(w);
}

/**
 * Sayings and words that happen to be a first name: "Uncle Sam", "the Book of Ruth", "Amazing Grace", "Jack in the
 * box", and "Will" asking something ("Will you look at that!").
 */
function isIdiom(before: string, match: string, after: string, ownPhotos = false): boolean {
  const m = bare(match);
  // A kinship word and the name on their own photograph is them ("Uncle Sam hugged the kids").
  if (!ownPhotos && m === "sam" && /(?<![\p{L}])uncle[ \t]+$/iu.test(before)) return true;
  if (m === "ruth" && /(?<![\p{L}])book[ \t]+of[ \t]+$/iu.test(before)) return true;
  if (m === "grace" && /(?<![\p{L}])amazing[ \t]+$/iu.test(before)) return true;
  if (m === "jack" && /^[ \t]+in[ \t]+the[ \t]+box(?![\p{L}])/iu.test(after)) return true;
  if (m === "will" && /^[ \t]+(?:you|we|they|it|he|she|i|this|that|there)(?![\p{L}\p{M}'’])/iu.test(after)) return true;
  // An epithet: "Catherine the Great", "Peter The Great", "Alfred the Great".
  if (/^[ \t]+the[ \t]+great(?![\p{L}\p{M}])/iu.test(after)) return true;
  // The apostles: "Saints Peter and Paul", "Peter And Paul Church".
  if (m === "peter" && /^[ \t]+(?:and|&)[ \t]+paul(?![\p{L}\p{M}])/iu.test(after)) return true;
  if (m === "paul" && /(?<![\p{L}\p{M}])peter[ \t]+(?:and|&)[ \t]+$/iu.test(before)) return true;
  return false;
}

/** Kinship words that mean the same person: "Nana Ruth" is Grandma Ruth. */
const KIN_GROUPS: string[][] = [
  ["grandma", "nana", "nanna", "nan", "granny", "gran", "grandmother", "oma", "abuela", "nonna", "bubbe"],
  ["grandpa", "granddad", "grandad", "gramps", "grandfather", "opa", "abuelo", "nonno", "zayde", "pop", "pops"],
  ["mom", "mum", "mother", "mama", "ma", "mommy", "mummy"],
  ["dad", "father", "papa", "pa", "daddy"],
  ["aunt", "auntie", "aunty", "tia", "tía"],
  ["uncle", "tio", "tío"],
];
const KIN_CANON = new Map(KIN_GROUPS.flatMap((g) => g.map((w) => [unaccented(w), g[0]] as const)));

/** A kinship word (or hyphenated run, "Great-Aunt") as compared: each word by its group ("nana" is "grandma"). */
export function kinshipKey(run: string): string {
  return bare(run)
    .split(/[\s\-‐]+/u)
    .filter(Boolean)
    .map((w) => KIN_CANON.get(w) ?? w)
    .join(" ")
    // A grand-aunt is a great-aunt.
    .replace(/(?<![\p{L}])grand (aunt|uncle)(?![\p{L}])/gu, "great $1");
}

/** A word that only makes the kinship word after it another title ("Great" of "Great Aunt"), not one on its own. */
export function isTitlePrefix(word: string): boolean {
  return /^(?:great|step|half|grand)$/iu.test(word);
}

/** The kinship title right before a name, "Great Aunt" and "Step-Mom" as one. */
const KIN_BEFORE = /(?<![\p{L}\p{M}])((?:(?:great|step|half|grand|big|little|baby|old|young)[ \t]+)*\p{L}[\p{L}\p{M}'’.-]*)[ \t]+$/iu;
/** Words that make the kinship word after them another title: "Great Grandma" is not Grandma. */
const TITLE_PREFIX = /(?<![\p{L}\p{M}])(?:great|step|half|grand)[ \t]+$/iu;

/** Marks a stand-in whose kinship word goes with it (see nameMatcher). */
const KIN_MARK = "\u0001";

/** Whether a word is a title or kinship word ("Uncle", "Grandma", "Dr."). */
export function isKinWord(word: string): boolean {
  return isKin(word);
}

/** Whether a word is an everyday word or a month ("may", "grace", "summer"): a name made of them is written as one. */
export function isEverydayWord(word: string): boolean {
  return EVERYDAY_WORDS.has(bare(word));
}

/** Whether a text reads as a title in title case, judged without these words (the name looked for), in the sentence at `at`. */
export function inTitleCase(text: string, own: string[] = [], at?: number): boolean {
  return at === undefined ? titleCase(text, new Set(own.map(bare))) : titleCaseAt(text, at, new Set(own.map(bare)));
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
  // Judged on the words around the names in the same sentence, not the names, which are capitalized anyway: "Trip:
  // Ada Byron, 2019" is no title in title case, and neither is "Georgia waved." after two sentences of places.
  const titleOf = (a: number): boolean => {
    const [s0, s1] = sentenceAt(text, a);
    let rest = "";
    let from = s0;
    for (const [x, y] of spans) {
      if (y <= s0 || x >= s1) continue;
      rest += `${text.slice(from, Math.max(from, x))} `;
      from = Math.min(s1, y);
    }
    const sentence = rest + text.slice(from, s1);
    // A sentence of two capitalized words is judged with the whole text too (see titleCaseAt).
    if ((sentence.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? []).filter((w) => letters(w) >= 2).length >= 3) return titleCase(sentence, new Set());
    let all = "";
    let at = 0;
    for (const [x, y] of spans) {
      all += `${text.slice(at, x)} `;
      at = y;
    }
    return titleCase(sentence, new Set()) && titleCase(all + text.slice(at), new Set());
  };
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    const m = text.slice(a, b);
    const title = titleOf(a);
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
  /**
   * Away from their photographs, for a forget and a withdrawn naming: their names as anywhere else, a safe first
   * name included ("Barbara blows out the candles", "Mia blows bubbles"), but one beside another capitalized word is
   * somebody else's name or a place's however the text is written, in title case or all in capitals ("Santa Barbara
   * Pier", "Leo Martinez Park", "Lake Louise", "SANTA BARBARA PIER"), and a one-word name inside keywords or a tag
   * ("santa barbara") is not theirs on its own.
   */
  away?: boolean;
  /**
   * Deciding what everyone may read: a name beside another capitalized word is not excused by it ("Ximena Hut
   * Walk, in the snow."). Dates, sayings and a saint's places still are.
   */
  noNeighbourExcuse?: boolean;
  /**
   * With `tagged`: whether they are on this very photograph (the default), or only elsewhere in its trip, collection
   * or activity. Their short names count either way; only on their own photograph is a place-like name taken for
   * them wherever a place is not plainly meant ("Charlotte in the rain" of the "Charlotte, NC 2020" trip is the city).
   */
  onPhoto?: boolean;
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
  tombstoneForms: { form: string; capitalizedOnly: boolean; derived?: boolean; kinship?: string[] }[];
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
  const firstNames: { form: string; kinship: string[] }[] = []; // the first name of a full one, for the tombstone (kept only where they were)
  const ownKin = new Set<string>(); // kinship words of their own name ("grandma" of Grandma Ruth)
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
      // Their title as one: "Great Aunt" and "Great-Aunt" alike.
      const kinship = k ? [kinshipKey(tokens.slice(0, k).join(" "))] : [];
      for (const w of kinship) ownKin.add(w);
      // "June", "Grace", "Will": remembered, they would take every month and every question with them.
      if (ni === 0 && tokens.length === 1 && letters(s) >= 3 && !isKin(s) && !NOT_SAFE.has(bare(s)) && !MONTHS.has(bare(s))) oneWord.push(s);
      // "Sam" of Sam Kent, "Ruth" of Grandma Ruth, "Jack" and "Mary Ann": on the photographs they were tagged on,
      // "Jack at the lake" is still him. Months stay out ("May 2020").
      else if (ni === 0 && tokens.length >= 2) {
        const usable = (w: string) => letters(w) >= 2 && !isKin(w) && !NOT_A_NAME_WORD.has(bare(w)) && !MONTHS.has(bare(w));
        if (usable(core[0])) firstNames.push({ form: capitalized(core[0]), kinship });
        if (core.length >= 3 && usable(core[0]) && usable(core[1])) firstNames.push({ form: `${capitalized(core[0])} ${capitalized(core[1])}`, kinship });
      }
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
    const put = (m: string, offset: number, whole: string) => {
      // "Great Grandma Ruth" is somebody else than Grandma Ruth.
      if (isKin(m.split(/[ \t]+/u)[0]) && TITLE_PREFIX.test(whole.slice(0, offset))) return m;
      return standInFor(m, whole.slice(0, offset), whole.slice(offset + m.length), titleCaseAt(whole, offset, own));
    };
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
        const title = titleCaseAt(whole, offset, own);
        const somebodyElse = notThePerson(whole, offset, offset + m.length, {
          otherWords,
          own,
          isNameWord: (w) => shared.has(bare(w)) || own.has(bare(w)),
          // Away from their photographs, a one-word name of theirs beside another capitalized word is somebody's or
          // a place's even in a title written in title case ("Santa Barbara Pier", "Lake Louise"): nothing there
          // says it is them.
          title: (title || Boolean(where.noNeighbourExcuse)) && !(where.away && !where.tagged),
          away: Boolean(where.away && !where.tagged),
          // A month or an everyday word in a date, on their own photographs: "in May", "May 5", "May Day".
          date: everyday,
          // Away from their photographs a first name that is also a place is one after "to", "in", "near" ("to
          // Florence"), and one before a number is a date or a thing ("Florence 2019"); on them, only a place written
          // as one ("Florence, Italy").
          // A first name taken from a full one is the place after "to" even there ("We flew to Florence.").
          place: !where.tagged || where.onPhoto === false ? "wide" : "travel",
          ownPhotos: Boolean(where.tagged) && where.onPhoto !== false,
          number: !where.tagged,
        });
        if (somebodyElse) return m;
        const before = whole.slice(0, offset);
        // On their own photograph, a kinship word before their name is them too: "Grandpa Sam at the lake" is "A
        // family member at the lake" — unless their name carries another one ("Aunt Ruth" is not Grandma Ruth).
        const kin = before.match(KIN_BEFORE);
        // "the Great Ada" has no kinship word: "Great" is one only before another ("Great Aunt").
        if (kin && !isTitlePrefix(kin[1]) && kin[1].split(/[ \t]+/u).every((w) => isKin(w.replace(/\.$/u, "")))) {
          if (ownKin.size && !ownKin.has(kinshipKey(kin[1]))) return m;
          if (where.tagged && where.onPhoto !== false) {
            const rest = before.slice(0, before.length - kin[0].length);
            return `${KIN_MARK}${standInFor(m, rest, whole.slice(offset + m.length), title)}`;
          }
        }
        return standInFor(m, before, whole.slice(offset + m.length), title);
      });
      // The kinship word goes with the name it was part of.
      if (out.includes(KIN_MARK)) out = out.replace(new RegExp(`${KIN_BEFORE.source.slice(0, -1)}${KIN_MARK}`, "giu"), "").replaceAll(KIN_MARK, "");
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
      // Off their own photograph, "st. mary's church" in the keywords is still a church.
      const saintly = !(where.tagged && where.onPhoto !== false);
      const put = (m: string, offset: number, w: string) => (saintly && SAINT_BEFORE.test(w.slice(0, offset)) ? m : standIn(m, w.slice(0, offset), w.slice(offset + m.length)));
      let out = scrubText(t, where);
      const k = keywordsFor(where);
      if (k.pairRx) out = out.replace(k.pairRx, put);
      if (k.strongRx) out = out.replace(k.strongRx, put);
      // A one-word name that is all of theirs is them in lower case too, anywhere: "ximena fishing" — except, away
      // from their photographs under `away`, where keywords run words together ("santa barbara pier").
      if (wholeRx && !(where.away && !where.tagged)) out = out.replace(wholeRx, put);
      return out === t ? out : withoutDoubledArticle(out);
    });
  const mentions = (text: unknown, where: Where = {}) => typeof text === "string" && text !== "" && scrub(text, where) !== text;
  const namesTag = (tag: unknown, where: Where = {}) => {
    if (typeof tag !== "string" || !tag.trim()) return false;
    try {
      const t = tag.trim().toLowerCase().replace(/’/g, "'");
      const k = keywordsFor(where);
      // Off their own photograph a saint's name in a tag is a place's ("st. mary's church").
      const saintly = !(where.tagged && where.onPhoto !== false);
      if (k.strongRx && [...tag.matchAll(new RegExp(k.strongRx.source, "giu"))].some((x) => !(saintly && SAINT_BEFORE.test(tag.slice(0, x.index))))) return true;
      if (k.pairRx && new RegExp(k.pairRx.source, "iu").test(tag)) return true;
      const bareTag = bare(t.replace(/'s$/u, ""));
      if (k.weakWords.includes(bareTag)) return true;
      if ((where.tagged ? [...cjkAlbum, ...cjkTagged] : cjkAlbum).some((f) => t.replace(/\s+/g, "").includes(f.replace(/\s+/g, "")))) return true;
      if (safe.some((x) => t === x.form.toLowerCase() || t === `${x.form.toLowerCase()}'s`)) return true;
      // A safe one-word name is all of their name: a tag containing it ("sam's bike") is about them — not, away from
      // their photographs under `away`, one where it is part of something else's name ("santa barbara").
      return Boolean((!(where.away && !where.tagged) && wholeTest?.test(tag)) || longAnyTest?.test(tag));
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
      ...firstNames.map(({ form, kinship }) => ({ form, capitalizedOnly: true, derived: true, kinship })),
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
  const prose = { title: text(a.title), caption: text(a.caption), description: text(a.description), place: maybe(a.place), activity: maybe(a.activity), visibleText: maybe(a.visibleText), mood: maybe(a.mood) };
  // Away from their photographs (`away`) a one-word name inside keywords or a tag is not taken for them on its
  // own ("santa barbara").
  const named = where.away && !where.tagged && (Object.keys(prose) as (keyof typeof prose)[]).some((k) => m.mentions(a[k], where));
  // Once the record's own words named them, its keywords and tags are cleaned as on their own photographs: any word
  // of their name, in any case ("barbara's 80th", "barbara birthday candles").
  // (Not as on their own photograph for anything else: "st. mary's church" there is still a church.)
  const words: Where = named ? { ...where, away: false, tagged: true, onPhoto: false } : where;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && !m.namesTag(t, words)) : []);
  return {
    ...a,
    ...prose,
    searchSummary: typeof a.searchSummary === "string" ? m.scrubKeywords(a.searchSummary, words) : "",
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
