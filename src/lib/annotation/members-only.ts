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
 * Judged from what it could have been given rather than what it happened to say: notes, or anybody tagged on the
 * item. A name the album knows turning up anyway (from a title, a handwritten caption, or a guess it should not have
 * made) counts as well. Erring this way only ever costs a stranger a description.
 */
export async function writtenFromMembersOnly(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null): Promise<boolean> {
  if (context?.trim()) return true;
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  if (face || animal) return true;
  const said = [text.title, text.caption, text.description, text.searchSummary, text.place, ...text.tags].filter(Boolean).join("\n");
  return mentionsAnyName(said, await knownNames());
}

/**
 * The same judgement for a trip's, a collection's or an activity's description: the helper was handed names, or the
 * notes on the photographs it was shown, or what it wrote names somebody the album knows.
 */
export async function descriptionFromMembersOnly(description: string, given: { names: string[]; notes: boolean }): Promise<boolean> {
  if (given.names.length || given.notes) return true;
  return mentionsAnyName(description, await knownNames());
}

/** Everybody the album has a name for: the people and pets it knows, and its members. */
async function knownNames(): Promise<string[]> {
  const [people, members] = await Promise.all([
    db.person.findMany({ select: { name: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
  ]);
  return [...people.map((p) => p.name), ...members.map((m) => m.name ?? "")];
}

/**
 * Whether any word of any of these names appears in the text as a whole word, ignoring case. Every word, not only
 * the whole name: "Grandma Jo" is written "Jo" as often as not, and a false alarm only keeps a sentence in the family.
 */
export function mentionsAnyName(text: string, names: string[]): boolean {
  const words = new Set(names.flatMap((n) => n.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 2).map((w) => w.toLowerCase()));
  if (!words.size || !text) return false;
  // Letters and digits only, so nothing in a word needs escaping.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...words].join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(text);
}
