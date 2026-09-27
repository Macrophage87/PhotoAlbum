/**
 * The relaxed name check (see name-check.ts): the strict matcher (strict-names.ts) and exactly three more excuses, for
 * a child's name that is also an everyday word, a month or season, or a place. Everything else stays as strict as
 * ever: accents, invisible characters, plurals and possessives, hyphens, dashes, hashtags, somebody's full name.
 *
 * Only a match that is exactly one of their single-word first names (no "'s", no plural "s", never a surname: see
 * strictForms), written in plain letters (no
 * accent, invisible character or compatibility form inside it), with nothing but a space or a stop against it (no
 * hyphen, digit or apostrophe), is ever excused, and only by one of these:
 *
 * (a) "word": an everyday word (COMMON_WORD_NAMES, and "jack"; not a month but "may", not a season, which go by (b))
 *     written all in lower case, in prose (never in keywords, tags or objects, lower case by design), and only in one
 *     of two shapes: right after a determiner ("a rose bush", "the grace period", "some hope"; a/an/the/some/any/every/
 *     each/no/this/that/these/those), or in a fixed phrase of its own ("we hope you", "hope it", "saying grace", "it
 *     may be", "we will have"; see PHRASES). Nothing about where a sentence starts is trusted: "happy birthday rose",
 *     "love you grace", "baby rose at the beach", "uncle will at the beach", "our little rose" are all held.
 * (b) "time": a month or season after a time word ("in", "during", "since", "until", optionally with "the", or
 *     "early", "late", "mid", "last", "next", "every"; not "this" or "all": "Look at this May!"; not "up next", not
 *     "the late"), or before a time noun ("vacation", "break", "holidays", "sun", "sunshine", "morning", "evening",
 *     "weather", "day", "night"): "A swim in May", "Late June at the lake", "Summer vacation", "June sunshine". Never
 *     after "with", "from", "by", "for", "and", "&" or "+" ("Flowers from June").
 * (c) "place": a listed place (PLACE_NAMES) after "in", "across" or "leaving", optionally with "the" ("The Duomo in
 *     Florence"), or after "to" or "from" right after a word of travel ("Driving to Austin", "Flight from Paris"; not
 *     "A letter to Austin", "The bus to Austin"), or before a capitalized place word ("Brooklyn Bridge", "at Madison
 *     Square Garden"), which in text written all in capitals word by word ("Madison Zoo Adventures") counts only
 *     after a determiner or a preposition. "At", "near", "around" and "visiting" never make it a place ("Smiling at
 *     Jordan", "Arms around Jordan", "Visiting Madison in the hospital"). Never after "with", "and", "&", "+", "for"
 *     or "by"; never before "at the" ("Madison at the zoo") or "and" and a name ("Paris and Leo").
 *
 * None, ever, before something a person does, "is", "was", "has", "had", "and", "&" or "+", a comma between or not
 * ("Last May swam", "This June is so happy", "Late June, is she ready?"). Their full name is never excused.
 *
 * The list is closed: anything not here is refused as the strict matcher refuses it.
 */
import { COMMON_WORD_NAMES } from "@/lib/annotation/names";
import { PLACE_NAMES } from "./places";
import { isPersonVerb } from "./scrub";

export type Excuse = "word" | "time" | "place";

const MONTH_WORDS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
const SEASONS = new Set(["spring", "summer", "autumn", "fall", "winter"]);
/**
 * Everyday words a name may be (names.ts's own list), and "jack", which that list leaves to its capital; not the months
 * but "may" (a verb), nor the seasons, which are only ever excused as a time.
 */
const EVERYDAY = new Set([...COMMON_WORD_NAMES, "jack"].filter((w) => w !== "the" && !SEASONS.has(w) && (!MONTH_WORDS.has(w) || w === "may")));
const DETERMINERS = new Set(["a", "an", "the", "some", "any", "every", "each", "no", "this", "that", "these", "those"]);
/** A word's own fixed phrases: the words that may come just before it, or just after it. */
const PHRASES: Record<string, { before?: string[]; after?: string[] }> = {
  hope: { before: ["i", "we", "they", "you"], after: ["you", "it", "to", "that", "so", "everyone"] },
  may: { before: ["i", "you", "it", "we", "they"], after: ["be", "have", "not"] },
  will: { before: ["i", "it", "we", "they", "you"], after: ["be", "have", "not", "never", "always"] },
  grace: { before: ["say", "says", "said", "saying"], after: ["period"] },
};
const TIME_BEFORE = new Set(["in", "during", "since", "until", "early", "late", "mid", "last", "next", "every"]);
/** Words that make "late" somebody's ("the late May"). */
const LATE_OF = new Set(["the", "our", "my", "his", "her", "their", "your"]);
/** Time words that may have "the" before the month or season: "in the summer". */
const TIME_BEFORE_THE = new Set(["in", "during", "since", "until"]);
const TIME_AFTER = new Set(["vacation", "break", "holidays", "sun", "sunshine", "morning", "evening", "weather", "day", "night"]);
const PLACE_BEFORE = new Set(["in", "across", "leaving"]);
/** Words of travel that make "to" or "from" after them a journey's: "Driving to Austin", "Flight from Paris". */
const TRAVEL = new Set([
  "drive", "drives", "driving", "drove", "driven", "fly", "flies", "flying", "flew", "flown", "flight", "flights", "trip", "trips", "journey", "travel", "travels",
  "traveling", "travelling", "traveled", "travelled", "headed", "heading", "moving", "moved", "ferry",
  "arrive", "arrived", "arriving", "return", "returned", "returning", "sailed", "sailing",
]);
const PLACE_AFTER = new Set(["bridge", "square", "park", "garden", "river", "street", "avenue", "station", "harbor", "harbour", "valley", "beach", "airport", "zoo", "museum", "cathedral"]);
/** Words before a name that make it somebody's: "with Rose", "from June", "and Paris". */
/** A determiner or a preposition before a place's name: what makes "the Georgia Zoo" a place in title-case text. */
const PLACE_LEAD = new Set([...DETERMINERS, "at", "in", "on", "near", "to", "from", "across", "around", "into", "through", "past", "over", "visiting"]);
/** Small words title case leaves in lower case. */
const TITLE_SMALL = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "by", "with", "from"]);
const NEVER_BEFORE_TIME = new Set(["with", "from", "by", "for", "and", "&", "+"]);
const NEVER_BEFORE_PLACE = new Set(["with", "and", "&", "+", "for", "by"]);
/** Words after a name that make it somebody doing or being something, as a person verb does: "This June is so happy". */
const BEING = new Set(["is", "was", "has", "had", "and", "&", "+"]);

/** One match of the strict matcher, as its loop sees it. */
export type Match = {
  /** The original text, and where the match is in it. */
  text: string;
  start: number;
  end: number;
  /** The normalized text (strict-names.ts), and where the match is in it. */
  norm: string;
  at: number;
  to: number;
  /** Keywords, tags or objects (StrictOptions.list). */
  list: boolean;
};

/** The word, "&" or "+" just before normalized offset `at`, with only spaces or tabs between; and the one before that. */
function wordsBefore(norm: string, at: number): [string, string] {
  const m = /(?:(?<![\p{L}])(\p{L}+|[&+])[ \t]+)?(?<![\p{L}])(\p{L}+|[&+])[ \t]+$/u.exec(norm.slice(0, at));
  return [m?.[2] ?? "", m?.[1] ?? ""];
}

/** The word, "&" or "+" just after, with only spaces or tabs between. */
function wordAfter(s: string): string {
  return /^[ \t]+(\p{L}+|[&+])/u.exec(s)?.[1] ?? "";
}

/** Somebody doing or being something next, a comma between or not: "swam", "is so happy", "and", ", is she". */
function personAfter(after: string): boolean {
  const w = wordAfter(after) || (/^[ \t]*,[ \t]*(\p{L}+|[&+])/u.exec(after)?.[1] ?? "");
  return Boolean(w) && (isPersonVerb(w) || BEING.has(w));
}

/** Written in title case throughout ("Madison Zoo Adventures"): every word but the small ones with a capital. */
function titleCase(text: string): boolean {
  const words = (text.match(/\p{L}[\p{L}'’]*/gu) ?? []).filter((w) => !TITLE_SMALL.has(w.toLowerCase()));
  return words.length >= 2 && words.every((w) => /^\p{Lu}/u.test(w));
}

/** A hyphen, a digit, an apostrophe, a hashtag or an invisible character against it: never excused. */
const EDGE = /[\s.,!?;:()"“”[\]]/u;

/**
 * Which excuse, if any, lets this match of a single-word name `form` stand in words shown to everyone under the
 * relaxed check. `form` is exactly one of the person's forms, normalized (strict-names.ts).
 */
export function relaxedExcuse(m: Match, form: string): Excuse | null {
  if (!/^\p{L}+$/u.test(form)) return null;
  const written = m.text.slice(m.start, m.end);
  // Plain letters only: an accent, an invisible character or a full-width letter keeps it strict.
  if (!/^\p{L}+$/u.test(written) || written.toLowerCase() !== form || m.norm.slice(m.at, m.to) !== form) return null;
  const before = m.text[m.start - 1];
  const after = m.text[m.end];
  if ((before !== undefined && !EDGE.test(before)) || (after !== undefined && !EDGE.test(after))) return null;
  const [prev, prev2] = wordsBefore(m.norm, m.at);
  const rest = m.norm.slice(m.to);
  const next = wordAfter(rest);
  if (personAfter(rest)) return null;

  // (a) An everyday word in lower case, in prose, after a determiner or in a fixed phrase of its own.
  if (!m.list && EVERYDAY.has(form) && written === form) {
    const phrase = PHRASES[form];
    if (DETERMINERS.has(prev) || phrase?.before?.includes(prev) || phrase?.after?.includes(next)) return "word";
  }

  // (b) A month or season used as a time.
  if (MONTH_WORDS.has(form) || SEASONS.has(form)) {
    const timeWord = TIME_BEFORE.has(prev) && !(prev === "next" && prev2 === "up") && !(prev === "late" && LATE_OF.has(prev2));
    const timeBefore = timeWord || (prev === "the" && TIME_BEFORE_THE.has(prev2));
    if (!NEVER_BEFORE_TIME.has(prev) && (timeBefore || TIME_AFTER.has(next))) return "time";
  }

  // (c) A listed place used as the place.
  if (PLACE_NAMES.has(form) && !NEVER_BEFORE_PLACE.has(prev)) {
    const original = m.text.slice(m.end);
    if (/^[ \t]+at[ \t]+the(?![\p{L}])/iu.test(original) || /^[ \t]*(?:and|&|\+)[ \t]+\p{Lu}/u.test(original)) return null;
    const placeWord = /^[ \t]+(\p{Lu}\p{Ll}+)(?![\p{L}\p{M}'’-])/u.exec(original)?.[1];
    const placeBefore = PLACE_BEFORE.has(prev) || (prev === "the" && PLACE_BEFORE.has(prev2)) || ((prev === "to" || prev === "from") && TRAVEL.has(prev2));
    const placeAfter = Boolean(placeWord && PLACE_AFTER.has(placeWord.toLowerCase())) && (!titleCase(m.text) || PLACE_LEAD.has(prev));
    if (placeBefore || placeAfter) return "place";
  }
  return null;
}
