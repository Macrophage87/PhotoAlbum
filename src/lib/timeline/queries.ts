import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsInLocalYear, idsMatching, intersectIds } from "@/lib/photos/page";
import { idsWithPerson } from "@/lib/people/in-photos";
import { withReadableDescription } from "@/lib/photos/readable-text";

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
 *
 * Who is looking is part of the filter (`filter.member`): it decides what the words may match and which activity
 * descriptions are read out.
 */
export async function tripTimeline(tripId: string, timezone: string, filter: GalleryFilter = NO_FILTER, /** The filter's id list, when the caller has already worked it out for several trips at once. */ restricted?: string[] | null): Promise<TimelineResult> {
  const active = filterIsActive(filter);
  const total = await db.photo.count({ where: { tripId, ...NOT_TRASHED, status: "READY" } });
  if (!active) {
    const [dated, undated, activities] = await Promise.all([
      db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: { not: null } }, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: photoCardSelect }),
      db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect }),
      db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
    ]);
    const groups = buildTimeline([...dated, ...undated], activities.map((a) => withReadableDescription(a, filter.member)), timezone);
    return { groups, matched: dated.length + undated.length, total, active };
  }

  const restrict = restricted === undefined ? await timelineIds(filter, tripId) : restricted;
  if (restrict && restrict.length === 0) return { groups: [], matched: 0, total, active };

  const where: Prisma.PhotoWhereInput = { tripId, ...narrowedWhere(filter, restrict) };
  const [dated, undated, activities] = await Promise.all([
    db.photo.findMany({ where: { ...where, takenAt: { not: null } }, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: photoCardSelect }),
    db.photo.findMany({ where: { ...where, takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect }),
    db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  const photos = [...dated, ...undated];
  const kept = new Set(photos.map((p) => p.activityId).filter(Boolean) as string[]);
  const groups = buildTimeline(photos, activities.filter((a) => kept.has(a.id)).map((a) => withReadableDescription(a, filter.member)), timezone);
  return { groups, matched: photos.length, total, active };
}

/**
 * Words and years are answered as id lists, the same ones the gallery uses, so the two agree about what matches.
 * Null when nothing is being asked that needs one. Without a trip the lists cover the whole album, so the timeline
 * of everything asks each question once rather than once per trip.
 */
export async function timelineIds(filter: GalleryFilter, tripId: string | null): Promise<string[] | null> {
  const lists: string[][] = [];
  // Who is asking decides what the words may match (see `idsMatching`); across the whole album a visitor's are
  // asked only of what sits somewhere public, so the limit is spent on what they could be shown.
  if (filter.q) lists.push(await idsMatching(filter.q, { member: filter.member, scope: tripId ? { tripId } : filter.member ? {} : { publicOnly: true } }));
  if (filter.year) lists.push(await idsInLocalYear(tripId, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  return lists.length ? intersectIds(lists) : null;
}

/** What a narrowed timeline keeps, apart from the trip: the plain columns the filter asks about, and the id list. */
function narrowedWhere(filter: GalleryFilter, restrict: string[] | null): Prisma.PhotoWhereInput {
  return {
    ...NOT_TRASHED,
    status: "READY",
    ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.activityId ? { activityId: filter.activityId } : {}),
    ...(restrict ? { id: { in: restrict } } : {}),
  };
}

/**
 * How many photographs each trip would put on its timeline, answered for many trips in one query, so the timeline
 * of everything can decide what goes on a page before it loads any of them. Narrowed, a trip with nothing that
 * matches is simply missing from the answer.
 */
export async function timelineCounts(tripIds: string[], filter: GalleryFilter = NO_FILTER, restrict: string[] | null = null): Promise<Map<string, number>> {
  if (!tripIds.length || (restrict && restrict.length === 0)) return new Map();
  const rows = await db.photo.groupBy({ by: ["tripId"], where: { tripId: { in: tripIds }, ...narrowedWhere(filter, restrict) }, _count: { _all: true } });
  return new Map(rows.flatMap((r) => (r.tripId ? [[r.tripId, r._count._all] as const] : [])));
}
