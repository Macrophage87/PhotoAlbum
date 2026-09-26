import { db } from "@/lib/db";
import type { StoredAnnotation } from "./schema";

/**
 * Whether the helper's text for an item is for members only.
 *
 * Strangers never read people's names, uploaders' names or the uploader's notes, and the helper is handed exactly
 * those — the names the family confirmed, so it will write "Ada and Ben on the porch", and the notes, which it is
 * told to trust. Asking it to leave them out again for strangers would be asking it to be careful, which is not the
 * same as being sure; so what it wrote from any of them is simply not shown or searchable outside the family.
 *
 * Judged from what it was given rather than what it happened to say: `sent` is what the request that produced it
 * carried (see `requestCarriesMembersOnly`), recorded when the request was built, so untagging somebody or clearing
 * the notes while a batch is out cannot make its answer public. Notes or anybody tagged now count as well, for
 * answers whose request was not recorded. Two things are judged from the words: a name the album knows turning up
 * anyway, and a word from the title of a trip or collection strangers cannot open (the helper is given those titles
 * too). The titles are checked by their words rather than flagged outright, because a trip is usually private while
 * it is being filled and made public afterwards, and flagging every description written in the meantime would leave
 * a public trip with none.
 */
export async function writtenFromMembersOnly(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null, sent?: boolean | null): Promise<boolean> {
  if (sent || context?.trim()) return true;
  if (await taggedOn(photoId)) return true;
  const said = [text.title, text.caption, text.description, text.searchSummary, text.place, ...text.tags].filter(Boolean).join("\n");
  return mentionsAnyName(said, await knownNames()) || mentionsAnyTitle(said, await privateTitlesOf(photoId));
}

/**
 * The same judgement for the helper's guess at where an item was: its name and its evidence line are shown beside
 * the pin, and it is written from the same notes and titles. The coordinates themselves are the item's position,
 * which the album shows anybody who may see it.
 */
export async function placeFromMembersOnly(photoId: string, place: { name: string | null; evidence: string | null }, context: string | null, sent?: boolean | null): Promise<boolean> {
  if (sent || context?.trim()) return true;
  const said = [place.name, place.evidence].filter(Boolean).join("\n");
  return mentionsAnyName(said, await knownNames()) || mentionsAnyTitle(said, await privateTitlesOf(photoId));
}

/**
 * What a request to the helper carries that only members may read: the uploader's notes, or confirmed names.
 * Recorded with the request (`annotationCustomId` for a batch) and handed back with its answer.
 */
export function requestCarriesMembersOnly(item: { context: string | null }, names: string[]): boolean {
  return Boolean(item.context?.trim()) || names.length > 0;
}

/**
 * A batch answer comes back with nothing but the id it was sent under, so what the request carried rides on that id:
 * `<photoId>-m` when it carried anything members-only. Ids are cuids, which have no hyphen.
 */
export function annotationCustomId(photoId: string, membersOnly: boolean): string {
  return membersOnly ? `${photoId}-m` : photoId;
}

/** The photograph an answer is for, and whether its request carried anything members-only (null: not recorded). */
export function parseAnnotationCustomId(customId: string): { photoId: string; sent: boolean | null } {
  const [photoId, mark] = customId.split("-");
  if (mark === undefined) return { photoId, sent: null };
  return { photoId, sent: mark === "m" ? true : null };
}

/**
 * The same judgement for a trip's, a collection's or an activity's description: the helper was handed names, the
 * notes on the photographs it was shown, the description it is replacing when that was members-only, or the title
 * of a trip strangers cannot open; or what it wrote names somebody the album knows.
 */
export async function descriptionFromMembersOnly(description: string, given: { names: string[]; notes: boolean; previous?: boolean; privateTitles?: string[] }): Promise<boolean> {
  if (given.names.length || given.notes || given.previous) return true;
  return mentionsAnyName(description, await knownNames()) || mentionsAnyTitle(description, given.privateTitles ?? []);
}

/**
 * A description a member saved by hand. Once members-only it stays so until a member says otherwise (the
 * "show this to everyone" control), however it is edited; fresh words that name somebody the album knows start
 * members-only, the same rule the helper's text is held to.
 */
export async function handWrittenMembersOnly(before: { descriptionMembersOnly: boolean } | null, text: string | null | undefined): Promise<boolean> {
  if (before?.descriptionMembersOnly) return true;
  return Boolean(text?.trim()) && mentionsAnyName(text!, await knownNames());
}

async function taggedOn(photoId: string): Promise<boolean> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  return Boolean(face || animal);
}

/** Titles of the trip and collections an item is in that strangers cannot open. */
async function privateTitlesOf(photoId: string): Promise<string[]> {
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { trip: { select: { title: true, visibility: true } }, collections: { select: { collection: { select: { title: true, visibility: true } } } } } });
  if (!p) return [];
  const all = [p.trip, ...p.collections.map((c) => c.collection)];
  return all.flatMap((c) => (c && c.visibility !== "PUBLIC" ? [c.title] : []));
}

/** Everybody the album has a name for: the people and pets it knows, and its members. */
export async function knownNames(): Promise<string[]> {
  const [people, members] = await Promise.all([
    db.person.findMany({ select: { name: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
  ]);
  return [...people.map((p) => p.name), ...members.map((m) => m.name ?? "")];
}

/**
 * Words that begin a name without being one: "van Gogh" is not somebody called Van. Mirrored by `name_patterns` in
 * the members_only_text migration.
 */
export const NAME_PARTICLES = new Set(["de", "la", "le", "da", "di", "du", "st", "van", "von", "der", "den", "del", "della", "dos", "das", "des", "san", "santa", "saint", "ste"]);

/** Lower case, accents off, so "José" in a name finds "Jose" in a sentence and the other way round. */
export function foldForNames(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

const wordsOf = (s: string) => foldForNames(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * What counts as a mention of a name: the whole name, and its first word when that is a given name of three letters
 * or more ("Grandma Jo" is written "Grandma" as often as not; "Jo" on its own is too short to tell from a word). Each
 * is a list of words, matched with anything between them. Mirrored by `name_patterns` in the migration.
 */
export function namePatterns(name: string): string[][] {
  const w = wordsOf(name);
  if (!w.length) return [];
  const out: string[][] = [];
  if (w.join("").length >= 2) out.push(w);
  if (w.length > 1 && w[0].length >= 3 && !NAME_PARTICLES.has(w[0])) out.push([w[0]]);
  return out;
}

/** One pattern for any of these alternatives as whole words, allowing a possessive or a plural ("Ada's", "the Smiths"). */
function wholeWords(alts: string[]): RegExp | null {
  if (!alts.length) return null;
  // Letters and digits only in each alternative, so nothing needs escaping.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?:['’]s|s)?(?![\\p{L}\\p{N}])`, "u");
}

/** Whether any of these names is mentioned in the text, as whole words, ignoring case and accents. */
export function mentionsAnyName(text: string, names: string[]): boolean {
  const pattern = wholeWords([...new Set(names.flatMap(namePatterns).map((w) => w.join("[^\\p{L}\\p{N}]+")))]);
  return Boolean(pattern && text) && pattern!.test(foldForNames(text));
}

/** Words too common in a title to say which trip a sentence came from. */
const TITLE_STOPWORDS = new Set(["with", "from", "this", "that", "trip", "week", "weekend", "photos", "photo", "pictures", "family", "holiday", "vacation", "visit", "summer", "winter", "spring", "autumn", "fall", "days", "into", "over", "around"]);

/** Whether any word of four letters or more from these titles appears in the text. Mirrored by `title_regex`. */
export function mentionsAnyTitle(text: string, titles: string[]): boolean {
  const pattern = wholeWords([...new Set(titles.flatMap(wordsOf).filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w) && !/^\d+$/.test(w)))]);
  return Boolean(pattern && text) && pattern!.test(foldForNames(text));
}
