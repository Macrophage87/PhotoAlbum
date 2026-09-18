import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsInLocalYear, idsMatching, intersectIds } from "@/lib/photos/page";
import { idsWithPerson } from "@/lib/people/in-photos";

export type TimelineResult = { groups: TimelineGroups; matched: number; total: number; active: boolean };

/**
 * A trip's whole timeline: every dated photograph in capture order, then the undated ones, with the trip's
 * activities in place — narrowed to whatever is being looked for.
 *
 * It used to come back four hundred photographs at a time, cut at a day boundary, with a "Later days" link at the
 * bottom — which meant a fortnight in Maine was four pages, the rail down the side listed only the days of the page
 * you happened to be on, and finding the afternoon you were after was a matter of guessing which page it fell in.
 * A timeline is a thing you scroll and scan; it is shown whole, and the panel beside it navigates it.
 *
 * Asking it a question narrows it in place rather than sending you to a separate list of results, which is the
 * point: the answer keeps the dates around it, so "the one with the lighthouse" comes back still sitting in the
 * afternoon it was taken. An activity is kept only while something inside it still matches, so a narrowed timeline
 * is the matches and nothing else.
 */
export async function tripTimeline(tripId: string, timezone: string, filter: GalleryFilter = NO_FILTER): Promise<TimelineResult> {
  const active = filterIsActive(filter);
  const total = await db.photo.count({ where: { tripId, ...NOT_TRASHED, status: "READY" } });
  if (!active) {
    const [dated, undated, activities] = await Promise.all([
      db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: { not: null } }, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: photoCardSelect }),
      db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect }),
      db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
    ]);
    const groups = buildTimeline([...dated, ...undated], activities, timezone);
    return { groups, matched: dated.length + undated.length, total, active };
  }

  // Words and years are answered as id lists, the same ones the gallery uses, so the two agree about what matches.
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q));
  if (filter.year) lists.push(await idsInLocalYear(tripId, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  if (restrict && restrict.length === 0) return { groups: [], matched: 0, total, active };

  const where: Prisma.PhotoWhereInput = {
    tripId,
    ...NOT_TRASHED,
    status: "READY",
    ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.activityId ? { activityId: filter.activityId } : {}),
    ...(restrict ? { id: { in: restrict } } : {}),
  };
  const [dated, undated, activities] = await Promise.all([
    db.photo.findMany({ where: { ...where, takenAt: { not: null } }, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: photoCardSelect }),
    db.photo.findMany({ where: { ...where, takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect }),
    db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  const photos = [...dated, ...undated];
  const kept = new Set(photos.map((p) => p.activityId).filter(Boolean) as string[]);
  const groups = buildTimeline(photos, activities.filter((a) => kept.has(a.id)), timezone);
  return { groups, matched: photos.length, total, active };
}
