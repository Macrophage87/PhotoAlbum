/**
 * Taking a forgotten person's name out of text the album wrote about them. Pure.
 *
 * A name is only ever a whole word: forgetting "Ed" must not turn "bedroom" into "ba family memberroom", and
 * forgetting "Ann" must leave "Annapolis", "annual" and "Ann-Marie" alone. Words are Unicode words — accents,
 * combining marks and non-Latin scripts count as letters — and a possessive ("Ann's") is still the name.
 */
import type { StoredAnnotation } from "@/lib/annotation/schema";

export const STAND_IN = "a family member";

/** Words that come before a name without being it: forgetting "Grandma Jo" must not rewrite every "Grandma". */
const TITLES = new Set(["grandma", "grandpa", "granny", "grandad", "granddad", "grandmother", "grandfather", "nana", "papa", "mama", "great", "aunt", "auntie", "aunty", "uncle", "cousin", "mom", "mum", "dad", "mr", "mrs", "ms", "dr", "baby", "little", "step"]);

/** "Great-Aunt" is a title as surely as "Aunt" is. */
function isTitle(word: string): boolean {
  return word.toLowerCase().split(/[-\u2010]/).every((part) => TITLES.has(part));
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ways the helper may have written this person: the whole name, and the first word of it that is a name
 * rather than a title ("Jo" of "Grandma Jo", "Ann" of "Ann Smith"), since a description told "Ann Smith" often
 * says "Ann" the second time.
 */
export function nameForms(name: string): string[] {
  const full = name.trim().replace(/\s+/g, " ");
  if (!full) return [];
  const words = full.split(" ").map((w) => w.replace(/[.,]+$/, ""));
  const given = words.find((w) => w.length >= 2 && !isTitle(w));
  const forms = [full];
  if (given && given.toLowerCase() !== full.toLowerCase()) forms.push(given);
  // The same name typed on another keyboard can arrive composed or decomposed; both are the same letters.
  const all = forms.flatMap((f) => [f.normalize("NFC"), f.normalize("NFD")]);
  // Longest first, so "Ann Smith" is replaced whole rather than as "a family member Smith".
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

const WORD = "\\p{L}\\p{M}\\p{N}";

/**
 * A whole-word, case-insensitive match for any of the forms. Not preceded by a letter, nor by a letter and a
 * hyphen or apostrophe (the "Neil" of "O'Neil", the "Marie" of "Ann-Marie"); not followed by a letter, nor by a
 * hyphen and a letter (the "Ann" of "Ann-Marie"). An apostrophe after it is a possessive and stays outside the match.
 */
function pattern(forms: string[], flags: string): RegExp {
  return new RegExp(`(?<![${WORD}])(?<![${WORD}][-‐'’])(?:${forms.map(escape).join("|")})(?![${WORD}])(?![-‐][${WORD}])`, flags);
}

/** Whether the text names this person anywhere, as a whole word. */
export function mentionsName(text: string | null | undefined, name: string): boolean {
  const forms = nameForms(name);
  if (!text || !forms.length) return false;
  // Non-global, so no lastIndex carries over from one call to the next.
  return pattern(forms, "iu").test(text);
}

/** At the start of the text or of a sentence the stand-in starts with a capital, as the name did. */
function startsSentence(before: string): boolean {
  return before.trim() === "" || /(?:[.!?]["'”’)]*\s+|\n\s*)$/u.test(before);
}

/** Replace every whole-word mention of the name with "a family member", keeping the text's case around it. */
export function scrubName(text: string, name: string): string;
export function scrubName(text: string | null | undefined, name: string): string | null;
export function scrubName(text: string | null | undefined, name: string): string | null {
  if (text == null) return null;
  const forms = nameForms(name);
  if (!forms.length) return text;
  return text.replace(pattern(forms, "giu"), (match: string, offset: number, whole: string) => {
    // Visible text is transcribed as written: "HAPPY BIRTHDAY ADA" stays shouting.
    if (match.length > 1 && match === match.toUpperCase() && match !== match.toLowerCase()) return STAND_IN.toUpperCase();
    return startsSentence(whole.slice(0, offset)) ? STAND_IN[0].toUpperCase() + STAND_IN.slice(1) : STAND_IN;
  });
}

/**
 * The helper's record with the name taken out of every piece of prose, and every tag or object naming them
 * dropped: a keyword like "ada" or "ada's birthday" is only there to find her, and "a family member's birthday"
 * is not a keyword anybody searches for. Tags that merely contain the letters ("adapter") stay.
 */
export function scrubAnnotation(a: StoredAnnotation, name: string): StoredAnnotation {
  const prose = (v: string | null | undefined) => scrubName(v, name);
  return {
    ...a,
    title: prose(a.title ?? "") ?? "",
    caption: prose(a.caption) ?? "",
    description: prose(a.description) ?? "",
    searchSummary: prose(a.searchSummary) ?? "",
    place: prose(a.place),
    activity: prose(a.activity),
    visibleText: prose(a.visibleText),
    mood: prose(a.mood),
    tags: (a.tags ?? []).filter((t) => !mentionsName(t, name)),
    objects: (a.objects ?? []).filter((t) => !mentionsName(t, name)),
  };
}
