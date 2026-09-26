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
];
// The members-only matcher's lists (src/lib/annotation/names.ts) are part of the same judgement: whatever it treats
// as an everyday word, a particle or a kinship word, so does this.
const NOT_SAFE = new Set([...KINSHIP, ...EVERYDAY, ...KINSHIP_WORDS, ...COMMON_WORD_NAMES, ...NAME_PARTICLES]);
const KIN = new Set([...KINSHIP, ...KINSHIP_WORDS]);
/** A full name needs one word that is more than a title, a kinship word or a particle ("Big Al" is not enough). */
const NOT_A_NAME_WORD = new Set([...KIN, ...NAME_PARTICLES, "and", "the", "of", "al", "el"]);
/** Everyday words and months: a name made only of them ("Holly Berry", "Rose Hill") is matched only as a name is written. */
const EVERYDAY_WORDS = new Set([...EVERYDAY, ...COMMON_WORD_NAMES].filter((w) => !KIN.has(w)));
/** Words that put a month (or an everyday word) in a date rather than a person in a sentence: "in May", "last May". */
const DATE_BEFORE = new Set(["in", "on", "by", "since", "until", "till", "early", "late", "mid", "last", "next", "this", "of", "from", "through"]);

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
  const title = titleCase(text, new Set());
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    const m = text.slice(a, b);
    const s = standIn(m, text.slice(0, a), text.slice(b));
    out += text.slice(at, a) + (title && s !== STAND_IN.toUpperCase() ? "A Family Member" : s);
    at = b;
  }
  return out + text.slice(at);
}

/** How names are compared once hashed: accents off, lower case, periods off, hyphens as spaces, one apostrophe. */
export function normalizeName(s: string): string {
  return unaccented(s.normalize("NFC")).toLowerCase().replace(/’/g, "'").replace(/[-‐]/g, " ").replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/**
 * Where a text is. `tagged`: on one of the person's own photographs (tagged, or once tagged), or a text about one.
 * `others`: the names of the other people tagged on that photograph, whose words are theirs there, not this person's.
 */
export type Where = { tagged?: boolean; others?: string[] };

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
   * What is remembered of them once they are forgotten (hashed, see tombstone.ts): their full names, and short names
   * that could be nobody else's. Never a short name that is also a word.
   */
  tombstoneForms: string[];
};

type Short = { form: string; word: string; everyday: boolean };

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
  const keywords = new Set<string>(); // any case, in keywords on their photographs
  const cjkAlbum: string[] = [];
  const cjkTagged: string[] = [];
  const capitalized = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const addShort = (w: string, isWhole: boolean) => {
    const word = bare(w);
    if (letters(w) < 2 || isKin(w)) return;
    const short = { form: capitalized(w), word, everyday: EVERYDAY_WORDS.has(word) };
    if (letters(w) >= 3 && !NOT_SAFE.has(word) && !shared.has(word)) {
      safe.push(short);
      if (isWhole) whole.push(w);
    } else taggedOnly.push(short);
  };
  for (const n of list) {
    const { name, nicknames } = splitNickname(n.trim().replace(/\s+/g, " "));
    for (const s of [name, ...nicknames]) {
      if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
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
      for (const w of core) if (letters(w) >= 2 && !NOT_A_NAME_WORD.has(bare(w))) for (const part of [w, ...w.split(/[-‐]/)]) if (letters(part) >= 2 && !isKin(part)) keywords.add(part);
      const fulls = [...new Set([tokens.length >= 2 ? s : null, core.length >= 2 ? core.join(" ") : null].filter((f): f is string => Boolean(f)))];
      for (const f of fulls) {
        const ws = f.split(" ");
        if (!ws.some((w) => letters(w) >= 2 && !NOT_A_NAME_WORD.has(bare(w)))) longTagged.push(ws.map(capitalized).join(" "));
        else if (ws.every((w) => isKin(w) || EVERYDAY_WORDS.has(bare(w)) || NOT_A_NAME_WORD.has(bare(w)))) longCap.push(ws.map(capitalized).join(" "));
        else longAny.push(f);
      }
      addShort(core[0], core.length === 1);
    }
  }
  const variants = (forms: string[]) => [...new Set(forms.flatMap((f) => [f.normalize("NFC"), f.normalize("NFD"), unaccented(f)]))].sort((a, b) => b.length - a.length);
  const withCaps = (forms: string[]) => variants(forms).flatMap((f) => [f, f.toUpperCase()]);
  const rx = (source: string, flags: string) => (source ? new RegExp(source, flags) : null);
  const longAnyRx = rx(bounded(variants(longAny)), "giu");
  const longAnyTest = rx(bounded(variants(longAny)), "iu");
  const longCapRx = rx(bounded(withCaps(longCap)), "gu");
  const wholeTest = rx(bounded(variants(whole)), "iu");
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
    const all = [...safe, ...extra];
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
        const before = whole.slice(0, offset);
        const after = whole.slice(offset + m.length);
        const prev = before.match(/([\p{L}\p{M}'’.-]+)[ \t]+$/u)?.[1] ?? null;
        const next = after.match(/^[ \t]+([\p{L}\p{M}'’.-]+)/u)?.[1] ?? null;
        const short = shorts.byForm.get(m) ?? [...shorts.byForm.values()].find((x) => bare(x.form) === bare(m)) ?? safeByForm.get(m);
        // Part of somebody else's name the album knows: "Ada Lovelace", "Mary Grace".
        if ((prev && otherWords.has(bare(prev))) || (next && otherWords.has(bare(next)))) return m;
        // A month or an everyday word in a date, on their own photographs: "in May", "May 5", "last May".
        if (short?.everyday && shorts.tagged.has(short.word) && ((prev && DATE_BEFORE.has(bare(prev))) || /^[\s,]*\d/u.test(after))) return m;
        const caps = isUpperWord(m);
        if (!title && !caps) {
          // "Ann Jones" is somebody else...
          if (next && /^\p{Lu}/u.test(next)) return m;
          // ...and so is "Mary Ann", unless the word before only says when ("On Sunday Grace") or who she is to
          // them ("Aunt Grace").
          if (prev && /^\p{Lu}/u.test(prev) && !isKin(prev) && !STARTERS.has(bare(prev))) return m;
        }
        return standInFor(m, before, after, title);
      });
    }
    return out;
  };

  /** Any word of their name, in any case, as keywords have it; not a word somebody else tagged there shares. */
  const keywordRx = (where: Where) => {
    if (!where.tagged) return null;
    const there = new Set((where.others ?? []).flatMap((o) => wordsOf(splitNickname(o).name).map(bare)));
    const words = [...keywords].filter((w) => !there.has(bare(w)));
    return rx(bounded(variants(words)), "giu");
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
      const out = scrubText(t, where);
      const k = keywordRx(where);
      return k ? out.replace(k, (m: string, offset: number, w: string) => standIn(m, w.slice(0, offset), w.slice(offset + m.length))) : out;
    });
  const mentions = (text: unknown, where: Where = {}) => typeof text === "string" && text !== "" && scrub(text, where) !== text;
  const namesTag = (tag: unknown, where: Where = {}) => {
    if (typeof tag !== "string" || !tag.trim()) return false;
    try {
      const t = tag.trim().toLowerCase().replace(/’/g, "'");
      const k = keywordRx(where);
      if (k && new RegExp(k.source, "iu").test(tag)) return true;
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
    tombstoneForms: [...new Set([...longAny, ...longCap, ...safe.map((x) => x.form), ...cjkAlbum])],
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
