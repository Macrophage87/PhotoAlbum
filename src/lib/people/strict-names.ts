/**
 * Whether words may name somebody, for deciding what strangers may read (the share guard, namesSomebodyRestricted, and
 * a withdrawn naming's show-to-everyone, withoutWithdrawnNames) and for taking a forgotten or withdrawn person's
 * name out of the helper's words on their own photographs (scrub.ts, tombstone.ts). Strict on purpose: refusing
 * leaves the words with the family until a member edits them, over-removal on their own photographs only loses a
 * word there, and a leak cannot be taken back. None of the language rules that decide what a forget rewrites
 * elsewhere are used here: every excuse they make ("the Great", "St.", "Uncle Sam", "Will you", a place after "to")
 * was a way for a child's name to reach strangers.
 *
 * Text and names are compared alike: compatibility forms folded (NFKC), invisible characters taken out (a zero-width
 * space or a soft hyphen inside "Madison"), accents off, letters without a plain form spelled out (Ł, ø, æ, ß), one
 * apostrophe, lower case, an en or em dash a space. A name is found as a whole word, plural or possessive with or
 * without an apostrophe ("Madisons", "mays"), however digits are run against it ("madison2016"), and either half of a
 * hyphenated word unless all of it is somebody else's name ("Madison-approved", not "Ann-Marie" of an album with an
 * Ann-Marie): any full name, the first name, a nickname
 * or former name, and a surname nobody else has that is no everyday word. A two-letter first name that is also a
 * small word ("An", "Is") only written with a capital. Any match counts, but for exactly three things:
 * - a month used as a date, in a date's own shape (see `monthAsDate`): "May 2019", "May 5, 2019", "the 5th of May.",
 *   "May Day";
 * - "Lake", "Mount", "Mt" or "Loch", capitalized and not after "the", and a listed place, with nothing after it but
 *   the end, a stop, or the time of day ("Lake Geneva at dawn.");
 * - somebody else the album knows, written in full in one field, with capitals and a single space between the words
 *   ("Grace Kelly" when the album has a Grace Kelly), never in keywords, tags or objects (StrictOptions.list): their
 *   name, not this person's. Kinship words are nobody's name words, so "Grandma Ruth" in the album hides no "Ruth".
 */
import { PLACE_NAMES } from "./places";
import { isKinWord, isNotANameWord, isPersonVerb, isWordSurname, splitNickname } from "./scrub";
import { splitCamel } from "@/lib/annotation/names";

/** Letters that do not come apart into a plain letter and an accent, spelled the way a keyboard without them does. */
const TRANSLIT: Record<string, string> = { ł: "l", ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", þ: "th", ı: "i" };

/** One character (or code point) as names are compared: see the file's comment. */
function normalizeChar(c: string): string {
  return c
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘ʼ`´]/gu, "'")
    // A hyphen is one, however it is typed; an en or em dash is no hyphen but a space between words ("day—Madison").
    .replace(/[‐‑]/gu, "-")
    .replace(/[–—―]/gu, " ")
    .toLowerCase()
    .replace(/[łøæœßđþı]/gu, (x) => TRANSLIT[x] ?? x);
}

/** Text as names are compared in it. */
export function strictNormalize(text: string): string {
  return normalizeText(text).text;
}

/** The normalized text, and for each of its characters the index in the original it came from. */
function normalizeText(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  let i = 0;
  for (const c of text) {
    const n = normalizeChar(c);
    for (let k = 0; k < n.length; k++) from.push(i);
    out += n;
    i += c.length;
  }
  from.push(i);
  return { text: out, from };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
/** Words before a month and a year that make a comma between them a date's: "late June, 2019". */
const DATE_WORDS = new Set(["in", "during", "since", "until", "till", "early", "late", "mid"]);
/**
 * Words in "-ing", "-ed" or "-s" after a month and a year that are no one doing something: "May 2019 during the
 * holidays", "June 2019 wedding", "May 2019 photos".
 */
const NOT_DOING = new Set(["photos", "pictures", "pics", "memories", "holidays", "vacations", "highlights", "adventures", "events", "trips", "plans", "news", "games", "classes", "lessons", "results", "festivities", "during", "morning", "evening", "spring", "wedding", "outing", "gathering", "meeting", "christening", "housewarming", "thanksgiving", "clothing", "building", "king", "thing", "something", "nothing", "everything", "anything", "ring", "string", "wing", "swing"]);
/** Words before a month and an ordinal day at the end that make them a date: "On May 5th.", "until June 1st!". */
const ORDINAL_DATE_WORDS = new Set([...DATE_WORDS, "on", "by", "before", "after", "from", "through"]);
/** A person after a month and a year: "June 2019 champion!", "May 2020 graduate". */
const PERSON_AFTER = /^[ \t]+(?:champion|champ|graduate|grad|winner|runner-up|girl|boy|baby|babe|star|queen|king|princess|prince|mvp|hero|kid|toddler|newborn|player|captain|student|athlete|swimmer|dancer|scholar|leader|helper|superstar|cutie|sweetie)s?(?![\p{L}])/u;
const TIME_WORDS = "dawn|dusk|sunrise|sunset|night|noon|midnight|twilight|daybreak|morning|evening|afternoon";
/** Two-letter names that are also small words: only written with a capital ("An", not "an"). */
const SMALL_WORDS = new Set(["an", "in", "on", "at", "to", "so", "no", "or", "as", "is", "it", "me", "we", "us", "he", "be", "do", "go", "my", "by", "of", "up", "am", "if", "al", "el", "la", "le", "de", "da", "di", "du"]);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The forms of one person's names to look for, normalized. `others`: words of other people's names. */
export function strictForms(names: string[], others: Set<string> = new Set()): string[] {
  const forms = new Set<string>();
  for (const raw of names) {
    const { name, nicknames } = splitNickname(raw.trim().replace(/\s+/g, " "));
    for (const [i, n] of [name, ...nicknames].entries()) {
      // A hyphenated first name stays one word ("Ann-Marie"), found hyphenated or spaced.
      const norm = strictNormalize(n).replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
      if (!norm) continue;
      if (CJK.test(norm)) {
        forms.add(norm.replace(/\s+/g, ""));
        continue;
      }
      const words = norm.split(" ").filter((w) => /\p{L}/u.test(w));
      if (!words.length) continue;
      // A name that is only a title ("Grandma" among former names) is nobody's to look for; a nickname is theirs ("Nan").
      if (i === 0 && words.every((w) => isKinWord(w))) continue;
      if (words.join("").replace(/[^\p{L}]/gu, "").length >= 2) forms.add(words.join(" "));
      // Past any title or kinship word: "Grandma Ruth" is Ruth, "Dr. Ed Jones" Ed.
      let k = 0;
      while (k < words.length - 1 && isKinWord(words[k])) k++;
      const core = words.slice(k).filter((w) => !isNotANameWord(w) || words.length === 1);
      if (!core.length) continue;
      const first = core[0];
      if (first.replace(/[^\p{L}]/gu, "").length >= 2) forms.add(first);
      if (core.length >= 2) forms.add(core.join(" "));
      // "Mary Ann Smith" is also "Mary Smith".
      if (core.length >= 3) forms.add(`${core[0]} ${core[core.length - 1]}`);
      // A surname nobody else has and that is no everyday word ("Okafor", not "Price" or a family's shared "Shaw").
      if (i === 0 && core.length >= 2) {
        const last = core[core.length - 1];
        if (last.replace(/[^\p{L}]/gu, "").length >= 3 && !isWordSurname(last) && !isNotANameWord(last) && !others.has(last)) forms.add(last);
      }
    }
  }
  return [...forms];
}

/**
 * A month used as a date, in normalized text, only in these shapes (the language review's fourth to seventh rounds):
 * - with a year, opening the text, a sentence or a line, or right after a date word ("May 2019", "In May 2019 we",
 *   "Since June 2021.", and with a comma "Late June, 2019"); after anything else it is them ("Grandpa with May
 *   2019.", "Ben + May 2019", "ben, may 2019"); and not before something a person does ("May 2020 swims",
 *   "smiling", "learned"), an age or a birth ("June 2019 months", "May 2016 born") or a person ("June 2019
 *   champion!");
 * - with a day and a year: "May 5, 2019"; or an ordinal day with a year ("May 5th, 2019"), or at the end after a date
 *   word or opening the text ("On May 5th.", "May 5th."), never in a list of names or places ("Ben 1st, May 3rd!");
 *   "the 5th of May.";
 * - a day named after it: "May Day" (with a capital, when `originalAfter` is given).
 * Anything else is them: "A swim in May.", "Late June at the lake", "May 5 at the beach", "Leo 7, May 5.", "Up next
 * June!". Over-refusal there is accepted; the photographs they were never tagged on keep the language rules.
 */
export function monthAsDate(before: string, after: string, originalAfter?: string): boolean {
  if (/^'?s(?![\p{L}])/u.test(after)) return false;
  const prevWord = /(\p{L}+)[ \t-]+$/u.exec(before)?.[1] ?? "";
  const year = /^[ \t]+\d{4}(?![\p{L}\p{N}])/u.exec(after) ?? (DATE_WORDS.has(/(\p{L}+)[ \t-]+$/u.exec(before)?.[1] ?? "") ? /^[ \t]*,[ \t]*\d{4}(?![\p{L}\p{N}])/u.exec(after) : null);
  if (year) {
    const rest = after.slice(year[0].length);
    const w = /^[ \t]+(\p{L}+)/u.exec(rest)?.[1];
    // Only opening the text, a sentence or a line, or right after a date word ("In May 2019", "Since June 2021."):
    // after anything else it is her ("Grandpa with May 2019.", "Ben + May 2019", "ben, may 2019").
    const opens = /(?:^|[\n.!?;:])[\s"'“‘(\[*_#>•-]*$/u.test(before);
    if (!opens && !ORDINAL_DATE_WORDS.has(prevWord)) return false;
    // Nor before an age, a birth, a person or something going on: "May 2016 born", "May 1999 age 5", "June 2019
    // champion!", "May 2020 smiling", "May 2020 loses her first tooth!", "May 2019 learned to ride".
    if (/^[ \t]+(?:months?|years?|weeks?|days?|old|born|age|aged)(?![\p{L}])/u.test(rest) || PERSON_AFTER.test(rest)) return false;
    return !(w && (isPersonVerb(w) || (/(?:ing|ed|s)$/u.test(w) && !NOT_DOING.has(w))));
  }
  const end = /^[ \t]*[.!?]*[ \t]*(?:$|\n)/u;
  const withYear = /^[ \t]*,[ \t]*\d{4}(?![\p{L}\p{N}])/u;
  const day = /^[ \t]+([12]?\d|3[01])(st|nd|rd|th)?(?![\p{L}\p{N}])/u.exec(after);
  if (day && Number(day[1]) >= 1) {
    const rest = after.slice(day[0].length);
    // An ordinal at the end only as a date is written: "On May 5th.", "May 5th." — not "Ben 1st, Leo 2nd, May 3rd!".
    const opens = /^[\s"'“‘(]*$/u.test(before);
    return withYear.test(rest) || (Boolean(day[2]) && end.test(rest) && (opens || ORDINAL_DATE_WORDS.has(prevWord)));
  }
  // "the 5th of May", "5th of May, 2019".
  if (/(?:^|[^\p{L}\p{N}])([12]?\d|3[01])(?:st|nd|rd|th)[ \t]+of[ \t]+$/u.test(before)) return withYear.test(after) || end.test(after);
  // "May Day".
  return /^[ \t]+day(?![\p{L}])/u.test(after) && (originalAfter === undefined || /^[ \t]+D/u.test(originalAfter));
}

/**
 * The spans of the original text to leave out of the matching: "Lake Geneva at dawn", written with a capital, not
 * after "the", a listed place, and nothing after it but the end, a stop or the time of day.
 */
export function lakeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const rx = /(?<![\p{L}\p{M}])(?<!(?:the|The|THE)[ \t]+)(?:Lake|LAKE|Mount|MOUNT|Mt\.?|MT\.?|Loch|LOCH)[ \t]+(\p{L}[\p{L}\p{M}]*)/gu;
  const tail = new RegExp(`^(?:[ \\t]+(?:(?:at|by|in)[ \\t]+)?(?:${TIME_WORDS}))?[ \\t]*(?:$|[.!?]+[ \\t]*(?:$|\\n))`, "u");
  for (const m of text.matchAll(rx)) {
    const start = m.index! + m[0].length - m[1].length;
    const end = m.index! + m[0].length;
    if (PLACE_NAMES.has(strictNormalize(m[1])) && tail.test(text.slice(end).toLowerCase())) spans.push([start, end]);
  }
  return spans;
}

/** `list`: keywords, tags or objects, where words run together and nobody else's full name excuses a match. */
export type StrictOptions = { list?: boolean };

export type StrictFinder = {
  /** Whether the text mentions them, but for the excuses above. */
  finds(text: unknown, opts?: StrictOptions): boolean;
  /** Where in the text (original offsets), to rewrite on their own photographs. */
  spans(text: string, opts?: StrictOptions): [number, number][];
  /** The hashtags holding a name of theirs (see `hashtagSpans`); with `fullOnly`, only a full name. */
  hashtags(text: string, fullOnly?: boolean): [number, number][];
};

/**
 * The whole hashtags that hold one of these forms: a word of it written in camel case ("#MayTheBirthdayGirl",
 * "#TeamMay"), or any form of three letters or more anywhere inside it ("#happybirthdaymay", "#amazinggrace").
 * `forms` normalized, as strictForms gives them; a two-letter one only as a capitalized word.
 */
export function hashtagSpans(text: string, forms: string[]): [number, number][] {
  const out: [number, number][] = [];
  const joined = forms.filter((f) => !CJK.test(f)).map((f) => ({ f, run: f.replace(/[\s-]+/gu, "") }));
  for (const h of text.matchAll(/[#＃]([\p{L}\p{M}\p{N}_\p{Cf}]+)/gu)) {
    const body = strictNormalize(h[1]).replace(/[_\d]+/gu, "");
    const words = splitCamel(h[1].replace(/\p{Cf}/gu, "")).split(/[^\p{L}\p{M}]+/u).filter(Boolean);
    const spaced = ` ${words.map(strictNormalize).join(" ")} `;
    const hit = joined.some(({ f, run }) => {
      if (run.length >= 3 && body.includes(run)) return true;
      if (!spaced.includes(` ${f.replace(/-/gu, " ")} `)) return false;
      return !SMALL_WORDS.has(f) || words.some((w) => strictNormalize(w) === f && /^\p{Lu}/u.test(w));
    });
    if (hit) out.push([h.index!, h.index! + h[0].length]);
  }
  return out;
}

/**
 * A finder for one person's names in words strangers may read, or on their own photographs. `others`: everybody
 * else's names, whose surnames are not this person's alone. `skip`: words not to look for (a word of the name of
 * somebody else tagged on the same photograph).
 */
export function strictFinder(names: string[], others: string[] = [], skip: Set<string> = new Set()): StrictFinder {
  const otherWords = new Set(others.flatMap((o) => strictNormalize(splitNickname(o).name).split(/[\s-]+/)).filter((w) => w && !isKinWord(w)));
  // Somebody else's name written without spaces that holds one of theirs: "花子" is not found inside "山田花子".
  const otherCjk = others.map((o) => strictNormalize(o).replace(/\s+/g, "")).filter((o) => CJK.test(o));
  const own = new Set(strictForms(names));
  const forms = strictForms(names, new Set([...otherWords].filter((w) => !own.has(w)))).filter((f) => !skip.has(f));
  // Somebody else in the album written in full holds one of theirs: "Grace" is not found in "Grace Kelly" when the
  // album knows a Grace Kelly (not a name of theirs too). Their own name beside it still is: "Grace Kelly and Grace".
  // Kinship words are nobody's name words: "Grandma Ruth" in the album does not hide "Ruth" in "Grandma Ruth".
  const otherFull = [...new Set(others.map((o) => strictNormalize(splitNickname(o).name).split(/\s+/u).filter((w) => w && !isKinWord(w)).join(" ")).filter((o) => o && !CJK.test(o) && /\s/u.test(o) && !own.has(o)))];
  // Within one field and one line, a single space or tab between the words, and written with capitals ("Tom Jordan",
  // not "tom jordan" run together in keywords, nor "Tom\nJordan" across two fields).
  const fullRx = otherFull.length ? new RegExp(`(?<![\\p{L}-])(?:${otherFull.sort((a, b) => b.length - a.length).map((o) => escape(o).replace(/ /g, "[ \\t]")).join("|")})(?:'?s)?(?![\\p{L}-])`, "gu") : null;
  // Somebody else's hyphenated name word holding one of theirs: "Ann" is not in "Ann-Marie" when the album knows an
  // Ann-Marie. Any other hyphenated word holds it ("Madison-approved", "Pre-Madison", "Madison-Rose").
  const otherHyphenated = new Set(others.flatMap((o) => strictNormalize(splitNickname(o).name).split(/\s+/u)).filter((w) => /\p{L}-\p{L}/u.test(w) && !own.has(w)));
  const cjk = forms.filter((f) => CJK.test(f));
  const small = new Set(forms.filter((f) => SMALL_WORDS.has(f)));
  const words = forms.filter((f) => !CJK.test(f)).sort((a, b) => b.length - a.length);
  // Whole words, letters only at the edges (digits or a hyphen run against a name do not hide it).
  const rx = words.length ? new RegExp(`(?<![\\p{L}])(?:${words.map((w) => escape(w).replace(/[ -]/g, "[\\s\\-]+")).join("|")})(?:'?s)?(?![\\p{L}])`, "gu") : null;
  // Written as one person's name: each word with a capital, and exactly one space or tab between them, as written.
  const capitalized = (original: string) => {
    const words = original.replace(/\p{Cf}/gu, "").split(/[ \t]/u);
    return words.every((w) => /^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(w));
  };
  const spans = (text: string, opts: StrictOptions = {}): [number, number][] => {
    if (!text.trim()) return [];
    const out: [number, number][] = [];
    const { text: t, from } = normalizeText(text);
    if (cjk.length) {
      const inside: [number, number][] = [];
      for (const o of otherCjk) for (const m of t.matchAll(new RegExp([...o].map(escape).join("\\s*"), "gu"))) inside.push([m.index!, m.index! + m[0].length]);
      for (const f of cjk) {
        const body = new RegExp([...f].map(escape).join("\\s*"), "gu");
        for (const m of t.matchAll(body)) {
          if (inside.some(([a, b]) => m.index! >= a && m.index! + m[0].length <= b && b - a > m[0].length)) continue;
          out.push([from[m.index!], from[m.index! + m[0].length]]);
        }
      }
    }
    // A hashtag holding a name of theirs is theirs whole.
    const tags = hashtagSpans(text, forms);
    out.push(...tags);
    if (!rx) return out.sort((a, b) => a[0] - b[0]);
    const lake = lakeSpans(text);
    // Judged on the original: a dash turned into a space ("Tom—Jordan") is no space between one person's names.
    const theirs: [number, number][] = fullRx && !opts.list ? [...t.matchAll(fullRx)].filter((m) => capitalized(text.slice(from[m.index!], from[m.index! + m[0].length]))).map((m) => [m.index!, m.index! + m[0].length]) : [];
    for (const m of t.matchAll(rx)) {
      if (theirs.some(([a, b]) => m.index! >= a && m.index! + m[0].length <= b)) continue;
      if (tags.some(([a, b]) => from[m.index!] >= a && from[m.index!] < b)) continue;
      // The whole hyphenated word it is in, if somebody else's name word.
      if (otherHyphenated.size) {
        const whole = `${/(?:\p{L}+-)+$/u.exec(t.slice(0, m.index))?.[0] ?? ""}${m[0]}${/^(?:-\p{L}+)+/u.exec(t.slice(m.index! + m[0].length))?.[0] ?? ""}`;
        if (whole !== m[0] && otherHyphenated.has(whole.replace(/'s$/u, ""))) continue;
      }
      const start = from[m.index!];
      const end = from[m.index! + m[0].length];
      const bare = m[0].replace(/'?s$/u, "");
      const word = MONTHS.has(bare) || small.has(bare) ? bare : m[0];
      if (lake.some(([a, b]) => start >= a && end <= b)) continue;
      // "An", not "an": a small word is only a name written with a capital.
      if (small.has(word) && !/^\p{Lu}/u.test(text.slice(start, end).replace(/\p{Cf}/gu, ""))) continue;
      if (MONTHS.has(m[0]) && monthAsDate(t.slice(0, m.index), t.slice(m.index! + m[0].length), text.slice(end))) continue;
      // A possessive's "'s" stays outside the span ("May's side" is "a family member's side"); a plural goes with it.
      out.push([start, /'s$/u.test(m[0]) ? from[m.index! + m[0].length - 2] : end]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  };
  const full = forms.filter((f) => /\s/u.test(f));
  return { spans, finds: (text, opts) => typeof text === "string" && spans(text, opts).length > 0, hashtags: (text, fullOnly) => hashtagSpans(text, fullOnly ? full : forms) };
}

/** A test for any mention of one person in words strangers may read (see `strictFinder`). */
export function strictMatcher(names: string[], others: string[] = []): (text: unknown, opts?: StrictOptions) => boolean {
  return strictFinder(names, others).finds;
}
