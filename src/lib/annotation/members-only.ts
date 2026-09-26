import { db } from "@/lib/db";
import type { StoredAnnotation } from "./schema";
import { mentionsAnyName, mentionsAnyTitle } from "./names";

export { foldForNames, mentionsAnyName, mentionsAnyTitle, NAME_PARTICLES, namePatterns } from "./names";

/**
 * Why a text is for members only. `titleOnly` when the one reason is a word from the title of a trip or collection
 * strangers cannot open: that reason goes away when the trip or collection is made public (see `rejudge.ts`), the
 * others never do.
 */
export type Judgement = { membersOnly: boolean; titleOnly: boolean };

const judged = (hard: boolean, title: boolean): Judgement => ({ membersOnly: hard || title, titleOnly: !hard && title });

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
 * anyway (see `names.ts`), and a word from the title of a trip or collection strangers cannot open (the helper is
 * given those titles too). The titles are checked by their words rather than flagged outright, because a trip is
 * usually private while it is being filled and made public afterwards.
 */
export async function judgeHelperText(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null, sent?: boolean | null): Promise<Judgement> {
  const said = helperText(text);
  const hard = Boolean(sent || context?.trim()) || (await taggedOn(photoId)) || mentionsAnyName(said, await knownNames());
  return judged(hard, mentionsAnyTitle(said, await privateTitlesOf(photoId)));
}

/** `judgeHelperText`, as a yes or no. */
export async function writtenFromMembersOnly(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null, sent?: boolean | null): Promise<boolean> {
  return (await judgeHelperText(photoId, text, context, sent)).membersOnly;
}

/** Everything the helper wrote about a photograph that anybody could read. */
export function helperText(text: Partial<Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">>): string {
  return [text.title, text.caption, text.description, text.searchSummary, text.place, ...(text.tags ?? [])].filter(Boolean).join("\n");
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
export async function judgeDescription(description: string, given: { names: string[]; notes: boolean; previous?: boolean; privateTitles?: string[] }): Promise<Judgement> {
  const hard = Boolean(given.names.length || given.notes || given.previous) || mentionsAnyName(description, await knownNames());
  return judged(hard, mentionsAnyTitle(description, given.privateTitles ?? []));
}

/** `judgeDescription`, as a yes or no. */
export async function descriptionFromMembersOnly(description: string, given: { names: string[]; notes: boolean; previous?: boolean; privateTitles?: string[] }): Promise<boolean> {
  return (await judgeDescription(description, given)).membersOnly;
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

type DescriptionBefore = { description: string | null; descriptionMembersOnly: boolean; descriptionSharedAt?: Date | null } | null;

/** The same words, give or take the line endings a textarea sends back and the spacing around them. */
export function sameDescription(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/**
 * What a description saved by hand is stored with. Members-only stays members-only (`handWrittenMembersOnly`); one a
 * member chose to show to everyone stays shown while its words are the same; new words are judged afresh.
 */
export async function handWrittenDescription(before: DescriptionBefore, text: string | null | undefined): Promise<{ descriptionMembersOnly: boolean; descriptionSharedAt: Date | null; unchanged: boolean }> {
  const unchanged = Boolean(before) && sameDescription(before!.description, text);
  if (unchanged && before!.descriptionSharedAt && !before!.descriptionMembersOnly) return { descriptionMembersOnly: false, descriptionSharedAt: before!.descriptionSharedAt, unchanged };
  return { descriptionMembersOnly: await handWrittenMembersOnly(before, text), descriptionSharedAt: null, unchanged };
}

/**
 * Whether the title on an item is the helper's, so that a members-only item loses it. The album records who wrote
 * a title (`titleByHelper`); a title from before it did is the helper's when it is one the helper gave (now or in a
 * past answer still kept), or when it names somebody — an old helper title such as "Ada's birthday cake" that a later
 * description did not repeat. A title the family typed since is never taken.
 */
export function titleIsHelpers(p: { title: string | null; titleByHelper: boolean | null; aiTitle: string | null; pastTitles?: string[]; namesSomebody?: boolean }): boolean {
  const own = p.title?.trim();
  if (!own || p.titleByHelper === false) return false;
  if (p.titleByHelper === true || own === p.aiTitle?.trim()) return true;
  return Boolean(p.pastTitles?.some((t) => t.trim() === own) || p.namesSomebody);
}

/** The titles in the helper's past answers for an item, from the raw responses still kept. */
export async function pastHelperTitles(photoId: string): Promise<string[]> {
  const raws = await db.mediaAnnotationRaw.findMany({ where: { photoId }, select: { response: true } });
  const titles: string[] = [];
  for (const r of raws) {
    const content = (r.response as { content?: { type?: string; text?: string }[] } | null)?.content;
    const text = Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
    try {
      const title = (JSON.parse(text) as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) titles.push(title.trim());
    } catch {
      // Not a record: nothing to learn from it.
    }
  }
  return titles;
}

async function taggedOn(photoId: string): Promise<boolean> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  return Boolean(face || animal);
}

/** Titles of the trip and collections an item is in that strangers cannot open. */
export async function privateTitlesOf(photoId: string): Promise<string[]> {
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
