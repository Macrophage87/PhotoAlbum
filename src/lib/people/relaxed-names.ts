/**
 * The relaxed name check (see name-check.ts): the strict matcher (strict-names.ts) and exactly three more excuses, for
 * a child's name that is also an everyday word, a month or season, or a place. Everything else stays as strict as
 * ever: accents, invisible characters, plurals and possessives, hyphens, dashes, hashtags, somebody's full name.
 *
 * Only a match that is exactly one of their single-word names (no "'s", no plural "s"), written in plain letters (no
 * accent, invisible character or compatibility form inside it), with nothing but a space or a stop against it (no
 * hyphen, digit or apostrophe), is ever excused, and only by one of these:
 *
 * (a) "word": an everyday word (COMMON_WORD_NAMES, and "jack") written all in lower case, not opening a sentence, in
 *     prose: "a rose bush", "saying grace", "we hope you", "our summer vacation". Never in keywords, tags or objects
 *     (lower case by design); never after "with", "and", "&", "+", "by", "for" or "from", or before "and", "&" or "+"
 *     ("presents for rose", "rose and ben"); never before something a person does ("will swim").
 * (b) "time": a month or season after a time word ("in", "during", "since", "until", optionally with "the", or
 *     "early", "late", "mid", "last", "next", "this", "every", "all"), or before a time noun ("vacation", "break",
 *     "holidays", "sun", "sunshine", "morning", "evening", "weather", "day", "night"): "A swim in May", "Late June at
 *     the lake", "Summer vacation", "June sunshine". Never after "with", "from", "by", "for", "and", "&" or "+"
 *     ("Flowers from June"), never before something a person does or "is", "was", "has", "had", "and", "&", "+"
 *     ("Last May swam", "This June is so happy").
 * (c) "place": a listed place (PLACE_NAMES) before a capitalized place word ("Brooklyn Bridge", "Madison Square
 *     Garden"), or after "in", "at", "to", "from", "near", "around", "across", "visiting" or "leaving", optionally with
 *     "the": "The Duomo in Florence", "Driving to Austin". Never after "with", "and", "&", "+", "for" or "by"; never
 *     before something a person does, "is", "was", "has", "had", "at the" ("Madison at the zoo"), or "and" and a name
 *     ("Paris and Leo"). Their full name is never a place.
 *
 * The list is closed: anything not here is refused as the strict matcher refuses it.
 */
import { COMMON_WORD_NAMES } from "@/lib/annotation/names";
import { PLACE_NAMES } from "./places";
import { isPersonVerb } from "./scrub";

export type Excuse = "word" | "time" | "place";

/** Everyday words a name may be (names.ts's own list), and "jack", which that list leaves to its capital. */
const EVERYDAY = new Set([...COMMON_WORD_NAMES, "jack"].filter((w) => w !== "the"));
const MONTH_WORDS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
const SEASONS = new Set(["spring", "summer", "autumn", "fall", "winter"]);
const TIME_BEFORE = new Set(["in", "during", "since", "until", "early", "late", "mid", "last", "next", "this", "every", "all"]);
/** Time words that may have "the" before the month or season: "in the summer". */
const TIME_BEFORE_THE = new Set(["in", "during", "since", "until"]);
const TIME_AFTER = new Set(["vacation", "break", "holidays", "sun", "sunshine", "morning", "evening", "weather", "day", "night"]);
const PLACE_BEFORE = new Set(["in", "at", "to", "from", "near", "around", "across", "visiting", "leaving"]);
const PLACE_AFTER = new Set(["bridge", "square", "park", "garden", "river", "street", "avenue", "station", "harbor", "harbour", "valley", "beach", "airport", "zoo", "museum", "cathedral"]);
/** Words before a name that make it somebody's: "with Rose", "from June", "and Paris". */
const NEVER_BEFORE_WORD = new Set(["with", "and", "&", "+", "by", "for", "from"]);
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

/** Somebody doing or being something next: a person verb ("swam"), "is holding", "is so happy", "and". */
function personAfter(after: string): boolean {
  const w = wordAfter(after);
  return Boolean(w) && (isPersonVerb(w) || BEING.has(w));
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

  // (a) An everyday word in lower case, in prose, inside a sentence.
  if (!m.list && EVERYDAY.has(form) && written === form) {
    const opens = /(?:^|[.!?;:\n])[\s"'“‘(\[*_>•-]*$/u.test(m.text.slice(0, m.start));
    if (!opens && /[ \t]$/u.test(m.text.slice(0, m.start)) && !NEVER_BEFORE_WORD.has(prev)) return "word";
  }

  // (b) A month or season used as a time.
  if (MONTH_WORDS.has(form) || SEASONS.has(form)) {
    const timeBefore = TIME_BEFORE.has(prev) || (prev === "the" && TIME_BEFORE_THE.has(prev2));
    if (!NEVER_BEFORE_TIME.has(prev) && (timeBefore || TIME_AFTER.has(next))) return "time";
  }

  // (c) A listed place used as the place.
  if (PLACE_NAMES.has(form) && !NEVER_BEFORE_PLACE.has(prev)) {
    const original = m.text.slice(m.end);
    if (/^[ \t]+at[ \t]+the(?![\p{L}])/iu.test(original) || /^[ \t]*(?:and|&|\+)[ \t]+\p{Lu}/u.test(original)) return null;
    const placeWord = /^[ \t]+(\p{Lu}\p{Ll}+)(?![\p{L}\p{M}'’-])/u.exec(original)?.[1];
    const placeBefore = PLACE_BEFORE.has(prev) || (prev === "the" && PLACE_BEFORE.has(prev2));
    if (placeBefore || (placeWord && PLACE_AFTER.has(placeWord.toLowerCase()))) return "place";
  }
  return null;
}
