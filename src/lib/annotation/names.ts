/**
 * Recognising a name the album knows in a sentence, for deciding what strangers may read (see `members-only.ts`).
 *
 * Privacy comes first, but a name that is also an everyday word must not take half the album with it: "Sand" the
 * dog is not in every beach photograph, and a rose bush is not Rose Walker. So a name is looked for as a whole, and
 * as each of its words that could only be a name — not a particle ("van", "de"), not a kinship or courtesy word
 * ("Uncle", "Mrs"), three letters or more — and a word that is also an everyday word is matched only written with
 * a capital, the way a name is. Accents are ignored either way, and a possessive or plural is allowed.
 */

/** Words that begin a name without being one: "van Gogh" is not somebody called Van. */
export const NAME_PARTICLES = new Set(["de", "la", "le", "da", "di", "du", "st", "van", "von", "der", "den", "del", "della", "dos", "das", "des", "san", "santa", "saint", "ste", "al", "el", "bin", "ibn"]);

/** What a family calls somebody before or instead of their name: "Uncle Bob" is Bob, and "Uncle" is everybody's. */
export const KINSHIP_WORDS = new Set([
  "uncle", "aunt", "auntie", "aunty", "grandma", "grandpa", "granny", "gran", "grandad", "granddad", "grandmother", "grandfather", "nana", "nan", "nanna", "papa", "pa", "ma", "mama", "mom", "mum", "mommy", "mummy", "dad", "daddy", "pop", "pops",
  "cousin", "sister", "brother", "baby", "little", "big", "great", "dr", "mr", "mrs", "ms", "miss", "sir", "madam", "the", "our", "my",
]);

/**
 * Names that are also everyday words. Matched only written as a name is — with a capital — never as the word:
 * "Sand" and "Rose Walker" are people, "sand" and "rose bush" are not.
 */
export const COMMON_WORD_NAMES = new Set([
  "sand", "rose", "grace", "will", "may", "june", "april", "august", "sunny", "river", "bear", "pepper", "max", "hope", "joy", "bill", "mark", "dawn", "summer", "autumn", "winter", "ivy", "holly", "amber", "faith", "chase", "hunter",
  "carol", "pat", "art", "frank", "guy", "the", "hens", "rock", "sky", "storm", "rain", "lily", "daisy", "violet", "ruby", "pearl", "jade", "penny", "buddy", "lucky", "ginger", "coco", "honey", "cookie", "shadow", "angel", "star",
  "brook", "forest", "dale", "glen", "wood", "stone", "hill", "field", "young", "king", "white", "black", "brown", "green", "gray", "grey", "bush", "park", "bell", "page", "law", "cook", "baker", "fisher", "miller", "love",
  "happy", "sweet", "blue", "red", "lake", "beach", "ocean", "snow", "spring", "fall", "north", "south", "west", "east", "rusty", "smokey", "patch", "socks", "misty", "sugar", "dusty", "chip", "rocky", "scout", "duke",
]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Accents off, case kept: "José" is "Jose". */
export function foldAccents(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "");
}

/** Lower case, accents off. */
export function foldForNames(s: string): string {
  return foldAccents(s).toLowerCase();
}

const tokens = (s: string) => foldAccents(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * One way a name may be written. `words` are matched with anything between them; `exactCase` ones only as written
 * (with a capital), the rest in any case. A `cjk` name is matched as its exact characters, since such text does not
 * put spaces between words; a single character only where it stands on its own.
 */
export type NamePattern = { words: string[]; exactCase: boolean; cjk?: boolean };

export function namePatterns(name: string): NamePattern[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  if (CJK.test(trimmed)) return [{ words: [trimmed.replace(/\s+/g, "")], exactCase: true, cjk: true }];
  const t = tokens(trimmed);
  const lower = t.map((w) => w.toLowerCase());
  if (lower.join("").length < 2) return [];
  const out: NamePattern[] = [];
  // The whole name. Made only of everyday words ("The Hens"), it is still matched only as a name is written.
  const everyday = lower.every((w) => COMMON_WORD_NAMES.has(w) || KINSHIP_WORDS.has(w) || NAME_PARTICLES.has(w));
  out.push(everyday ? { words: t.map(capital), exactCase: true } : { words: lower, exactCase: false });
  // Each word that can only be this person's: when any of them is too short to tell from a word ("Li Wei",
  // "Grandma Jo"), only the whole name is safe.
  const meaningful = lower.map((w, i) => ({ w, i })).filter(({ w }) => !NAME_PARTICLES.has(w) && !KINSHIP_WORDS.has(w));
  if (t.length > 1 && meaningful.length && meaningful.every(({ w }) => w.length >= 3)) {
    for (const { w, i } of meaningful) out.push(COMMON_WORD_NAMES.has(w) ? { words: [capital(t[i])], exactCase: true } : { words: [w], exactCase: false });
  }
  return out;
}

/**
 * A test for any of these ways of writing a name.
 *
 * Hundreds of names in one alternation are slow to compile and slow to try at every position of every description,
 * and the whole album is judged against all of them. So the patterns are grouped by their first word, and a text
 * only tries the few whose first word it actually has (possessive and plural allowed), each group compiled on first
 * use. The answer is the same as the one big pattern's.
 */
export function nameMatcher(patterns: NamePattern[]): ((text: string) => boolean) | null {
  if (!patterns.length) return null;
  const sep = "[^\\p{L}\\p{N}]+";
  const group = (ps: NamePattern[]) => {
    const byFirst = new Map<string, Set<string>>();
    for (const p of ps) byFirst.set(p.words[0], (byFirst.get(p.words[0]) ?? new Set()).add(p.words.join(sep)));
    return byFirst;
  };
  const ci = group(patterns.filter((p) => !p.cjk && !p.exactCase));
  const cs = group(patterns.filter((p) => !p.cjk && p.exactCase));
  const compiled = new Map<string, RegExp>();
  // Letters and digits only in each alternative, so nothing needs escaping.
  const regexFor = (key: string, alts: Set<string>) => {
    let re = compiled.get(key);
    if (!re) compiled.set(key, (re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...alts].join("|")})(?:['’]s|s)?(?![\\p{L}\\p{N}])`, "u")));
    return re;
  };
  const cjkRes = [...new Set(patterns.filter((p) => p.cjk).map((p) => p.words[0]))].map((c) => {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...c].length === 1 ? new RegExp(`(?<![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])${escaped}(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])`, "u") : new RegExp(escaped, "u");
  });
  return (text: string) => {
    if (!text) return false;
    if (cjkRes.some((r) => r.test(text))) return true;
    const folded = foldAccents(text);
    const lowered = folded.toLowerCase();
    const tried = new Set<string>();
    for (const w of folded.split(/[^\p{L}\p{N}]+/u)) {
      if (!w) continue;
      for (const exact of w.endsWith("s") ? [w, w.slice(0, -1)] : [w]) {
        const alts = cs.get(exact);
        if (alts && !tried.has(`cs:${exact}`)) {
          tried.add(`cs:${exact}`);
          if (regexFor(`cs:${exact}`, alts).test(folded)) return true;
        }
        const lower = exact.toLowerCase();
        const lalts = ci.get(lower);
        if (lalts && !tried.has(`ci:${lower}`)) {
          tried.add(`ci:${lower}`);
          if (regexFor(`ci:${lower}`, lalts).test(lowered)) return true;
        }
      }
    }
    return false;
  };
}

/** Whether any of these names is mentioned in the text. */
export function mentionsAnyName(text: string, names: string[]): boolean {
  const test = nameMatcher(names.flatMap(namePatterns));
  return Boolean(test && test(text));
}

/** Words too common in a title to say which trip a sentence came from. */
const TITLE_STOPWORDS = new Set(["the", "and", "our", "for", "with", "from", "this", "that", "trip", "week", "weekend", "photos", "photo", "pictures", "family", "holiday", "vacation", "visit", "summer", "winter", "spring", "autumn", "fall", "day", "days", "into", "over", "around", "new", "old", "big", "all", "out", "off", "fun", "two", "one"]);

/** The words of these titles worth looking for: three letters or more, not a number, not a word every title has. */
export function titleWords(titles: string[]): string[] {
  return [...new Set(titles.flatMap((t) => tokens(t).map((w) => w.toLowerCase())).filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/** Which words of these titles appear in the text (as `titleWords` has them). */
export function titleWordsIn(text: string, titles: string[]): string[] {
  const words = titleWords(titles);
  if (!words.length || !text) return [];
  const said = new Set(foldForNames(text).split(/[^\p{L}\p{N}]+/u).flatMap((w) => [w, w.replace(/s$/, "")]));
  return words.filter((w) => said.has(w));
}

/** Whether any word of these titles appears in the text. */
export function mentionsAnyTitle(text: string, titles: string[]): boolean {
  const words = titleWords(titles);
  if (!words.length || !text) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?:['’]s|s)?(?![\\p{L}\\p{N}])`, "u").test(foldForNames(text));
}
