import { db } from "@/lib/db";
import type { StoredAnnotation } from "./schema";
import { knownNamesLook, type NamesLook } from "./members-only";
import { restrictedMatchers } from "@/lib/people/restricted";
import { albumNameCheck, photoNameCheck, PLACED_SELECT, tripNameCheck, type NameCheck } from "@/lib/people/name-check";
import type { StrictOptions } from "@/lib/people/strict-names";

/**
 * Words shown to everyone only because the relaxed name check excused them (name-check.ts): marked where they are
 * (`relaxedReleaseAt` on an item, its place guess, a trip's, an activity's or a collection's description), so that
 * when a level, a place or who may be named changes, those words and only those are judged again
 * (rejudge.ts, `rejudgeNameCheck`). Words the strict check lets out are never marked: nothing about the relaxed check
 * ever reaches them.
 *
 * Marked after every write that shows words to everyone or keeps them shown, at the relaxed level: when the strict
 * check would hold them there and then. Cleared when they are no longer shown, or shown again at the relaxed level
 * without needing the excuse (edited clean). Shown under a strict level, a mark is left to the re-check, which takes
 * the words back or clears it.
 */

/** Whether words are held at a level: by the share guard, and for what the album publishes by itself also by names.ts. */
export type Holds = (level: NameCheck, texts: string[], lists: string[], published: boolean) => boolean;

/**
 * The two checks that let words out, at each level asked for: the share guard (strict-names.ts, relaxed for a child
 * alone) for everything, and the members-only rule's look at names (names.ts) for what the album published by itself
 * (`published`: the helper's text, place guesses and descriptions no member chose to show).
 */
export async function holdsAt(levels: NameCheck[] = ["STRICT", "RELAXED"]): Promise<Holds> {
  const at = new Map<NameCheck, { restricted: ((text: unknown, opts?: StrictOptions) => boolean)[]; names: NamesLook }>();
  for (const level of levels) at.set(level, { restricted: await restrictedMatchers(level), names: await knownNamesLook(level) });
  return (level, texts, lists, published) => {
    const look = at.get(level);
    if (!look) throw new Error(`No look at ${level}`);
    if (look.restricted.some((finds) => texts.some((t) => finds(t)) || lists.some((t) => finds(t, { list: true })))) return true;
    return published && look.names({ texts, lists });
  };
}

export type ShownRow = { kind: string; title: string | null; titleByHelper: boolean | null; membersTitle: string | null; annotation: unknown; annotationSharedAt: Date | null };

/**
 * The words of an item that are shown to everyone, as the check that let them out read them: the share guard's for
 * words a member showed (withoutWithdrawnNames: the helper's text, its title on the item, keywords, tags and objects),
 * the judgement's for the rest (judgeHelperText). A title a member typed is theirs to publish and is not asked about.
 */
export function shownOf(r: ShownRow): { texts: string[]; lists: string[] } {
  const a = (r.annotation ?? {}) as Partial<StoredAnnotation>;
  const title = r.kind !== "EXTERNAL_VIDEO" && r.titleByHelper !== false ? r.title : null;
  const texts = r.annotationSharedAt ? [title, a.caption, a.description, a.place, a.activity, a.visibleText, a.mood] : [title, r.membersTitle, a.title, a.caption, a.description, a.place];
  const lists = r.annotationSharedAt ? [a.searchSummary, ...(a.tags ?? []), ...(a.objects ?? [])] : [a.searchSummary, ...(a.tags ?? [])];
  const present = (l: unknown[]) => l.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  return { texts: present(texts), lists: present(lists) };
}

/** A place guess's words, as `placeFromMembersOnly` reads them. */
export const guessWords = (g: { placeEstimateName: string | null; placeEstimateNote: string | null }) => [g.placeEstimateName, g.placeEstimateNote].filter(Boolean).join("\n");

/** What a mark becomes: none when not shown; when shown at the relaxed level, whether the strict check holds it. */
async function marked(now: Date | null, shown: boolean, level: NameCheck, strictlyHeld: () => Promise<boolean>): Promise<Date | null> {
  if (!shown) return null;
  if (level !== "RELAXED") return now;
  return (await strictlyHeld()) ? (now ?? new Date()) : null;
}

/** Mark (or clear) an item's words and place guess after a write that may have shown them to everyone. */
export async function noteRelaxedRelease(photoId: string): Promise<void> {
  const r = await db.photo.findUnique({
    where: { id: photoId },
    select: { ...PLACED_SELECT, kind: true, title: true, titleByHelper: true, membersTitle: true, annotation: true, annotationRevision: true, annotationSharedAt: true, annotationMembersOnly: true, placeEstimateName: true, placeEstimateNote: true, placeEstimateMembersOnly: true, relaxedReleaseAt: true, placeRelaxedReleaseAt: true },
  });
  if (!r) return;
  const level = photoNameCheck(r, await albumNameCheck());
  let strict: Holds | null = null;
  const strictly = async () => (strict ??= await holdsAt(["STRICT"]));
  const text = await marked(r.relaxedReleaseAt, !r.annotationMembersOnly && r.annotation !== null, level, async () => {
    const shown = shownOf(r);
    return (await strictly())("STRICT", shown.texts, shown.lists, !r.annotationSharedAt);
  });
  const place = await marked(r.placeRelaxedReleaseAt, !r.placeEstimateMembersOnly && Boolean(r.placeEstimateName || r.placeEstimateNote), level, async () => (await strictly())("STRICT", [guessWords(r)], [], true));
  if (text?.getTime() === r.relaxedReleaseAt?.getTime() && place?.getTime() === r.placeRelaxedReleaseAt?.getTime()) return;
  // Against the words as judged: whoever changed them since marks them again.
  await db.photo.updateMany({
    where: { id: photoId, annotationRevision: r.annotationRevision, annotationSharedAt: r.annotationSharedAt, annotationMembersOnly: r.annotationMembersOnly, title: r.title, titleByHelper: r.titleByHelper, membersTitle: r.membersTitle, placeEstimateName: r.placeEstimateName, placeEstimateNote: r.placeEstimateNote, placeEstimateMembersOnly: r.placeEstimateMembersOnly },
    data: { relaxedReleaseAt: text, placeRelaxedReleaseAt: place },
  });
}

type Described = { description: string | null; descriptionByHelper: boolean; descriptionMembersOnly: boolean; descriptionSharedAt: Date | null; relaxedReleaseAt: Date | null };
const describedSelect = { description: true, descriptionByHelper: true, descriptionMembersOnly: true, descriptionSharedAt: true, relaxedReleaseAt: true } as const;

/** Mark (or clear) the helper's description of a trip, an activity or a collection after it was written or shown. */
export async function noteRelaxedDescription(kind: "trip" | "activity" | "collection", id: string): Promise<void> {
  const album = await albumNameCheck();
  const found: (Described & { level: NameCheck }) | null =
    kind === "trip"
      ? await db.trip.findUnique({ where: { id }, select: { ...describedSelect, nameCheck: true } }).then((t) => t && { ...t, level: tripNameCheck(t, album) })
      : kind === "activity"
        ? await db.activity.findUnique({ where: { id }, select: { ...describedSelect, trip: { select: { nameCheck: true } } } }).then((a) => a && { ...a, level: tripNameCheck(a.trip, album) })
        : await db.collection.findUnique({ where: { id }, select: describedSelect }).then((c) => c && { ...c, level: album });
  if (!found) return;
  const d = found;
  const mark = await marked(d.relaxedReleaseAt, d.descriptionByHelper && !d.descriptionMembersOnly && Boolean(d.description?.trim()), d.level, async () => (await holdsAt(["STRICT"]))("STRICT", [d.description!], [], !d.descriptionSharedAt));
  if (mark?.getTime() === d.relaxedReleaseAt?.getTime()) return;
  const where = { id, description: d.description, descriptionMembersOnly: d.descriptionMembersOnly, descriptionSharedAt: d.descriptionSharedAt, descriptionByHelper: d.descriptionByHelper };
  if (kind === "trip") await db.trip.updateMany({ where, data: { relaxedReleaseAt: mark } });
  else if (kind === "activity") await db.activity.updateMany({ where, data: { relaxedReleaseAt: mark } });
  else await db.collection.updateMany({ where, data: { relaxedReleaseAt: mark } });
}

/** Whether anything is marked anywhere: when not, a change of who may be named has nothing to judge again. */
export async function anyRelaxedRelease(): Promise<boolean> {
  const marked = { relaxedReleaseAt: { not: null } };
  const [photo, place, trip, activity, collection] = await Promise.all([
    db.photo.findFirst({ where: marked, select: { id: true } }),
    db.photo.findFirst({ where: { placeRelaxedReleaseAt: { not: null } }, select: { id: true } }),
    db.trip.findFirst({ where: marked, select: { id: true } }),
    db.activity.findFirst({ where: marked, select: { id: true } }),
    db.collection.findFirst({ where: marked, select: { id: true } }),
  ]);
  return Boolean(photo || place || trip || activity || collection);
}
