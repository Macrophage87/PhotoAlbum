import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { StoredAnnotation } from "./schema";
import { knownNames, helperText } from "./members-only";
import { mentionsAnyTitle, nameMatcher, namePatterns, type NamePattern } from "./names";

/**
 * Judging again what was written before something changed.
 *
 * The helper's text, its place guesses and descriptions are judged when they are written (see `members-only.ts`).
 * Two things can change afterwards: a name becomes known (somebody is added, tagged under a new name, renamed, or a
 * member sets their name), and a trip or collection changes visibility, which decides whether a word from its title
 * gives anything away. Both are answered here, in the background and in batches, never inside the request that
 * made the change.
 *
 * What it will not do: move a title the family typed (only the helper's own title is taken off the photograph),
 * touch anything a member chose to show to everyone (`annotationSharedAt`, `descriptionSharedAt`) — that stays
 * shown until it is written again — or flag on a name that is really a word: a name that matches more than a
 * sliver of everything the helper wrote is logged and left alone.
 */
export type RejudgeJob = { names?: string[]; tripId?: string; collectionId?: string };

export type RejudgeResult = { photos: number; unflagged: number; places: number; descriptions: number; broad: string[] };

const BATCH = 500;
/** A name found in more than this share of what the helper wrote (and in this many items at least) is a word. */
export const BROAD_SHARE = 0.05;
export const BROAD_MIN = 25;

type Row = { id: string; kind: string; title: string | null; membersTitle: string | null; annotation: unknown; annotationMembersOnly: boolean; annotationTitleOnly: boolean; annotationSharedAt: Date | null; trip: { title: string; visibility: string } | null; collections: { collection: { title: string; visibility: string } }[] };

const rowSelect = { id: true, kind: true, title: true, membersTitle: true, annotation: true, annotationMembersOnly: true, annotationTitleOnly: true, annotationSharedAt: true, trip: { select: { title: true, visibility: true } }, collections: { select: { collection: { select: { title: true, visibility: true } } } } } as const;

/** Every annotated photograph (or those in one trip or collection), a batch at a time. */
async function* annotated(where: object = {}): AsyncGenerator<Row[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows: Row[] = await db.photo.findMany({ where: { NOT: { annotation: { equals: Prisma.DbNull } }, ...where }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: rowSelect });
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
  }
}

const aiTitleOf = (r: Pick<Row, "annotation">) => ((r.annotation as StoredAnnotation | null)?.title ?? "").trim() || null;

/** The fields that make a photograph's helper text members-only, moving the helper's own title off it. */
function flagData(r: Row, titleOnly: boolean) {
  const ai = r.kind === "EXTERNAL_VIDEO" ? null : aiTitleOf(r);
  const own = r.title?.trim() || null;
  return {
    annotationMembersOnly: true,
    annotationTitleOnly: titleOnly,
    // Only the helper's own title moves off the item; one the family typed is theirs to publish, names and all.
    ...(ai && own === ai ? { title: null, membersTitle: ai } : ai && !r.membersTitle?.trim() ? { membersTitle: ai } : {}),
  };
}

/** The reverse, for a photograph whose only reason is gone: its helper title goes back on it if it has none. */
function unflagData(r: Row) {
  const ai = aiTitleOf(r);
  const back = ai && !r.title?.trim() && r.membersTitle?.trim() === ai;
  return { annotationMembersOnly: false, annotationTitleOnly: false, ...(back ? { title: ai, membersTitle: null } : {}) };
}

/** Titles of the trip and collections a photograph is in that strangers cannot open. */
const privateTitles = (r: Row) => [r.trip, ...r.collections.map((c) => c.collection)].flatMap((c) => (c && c.visibility !== "PUBLIC" ? [c.title] : []));

/**
 * Names: flag what mentions them and is not members-only yet (or is only because of a title word, which a name
 * outranks). `names` absent means everybody the album knows, which the worker asks for when it starts.
 */
export async function rejudgeNames(names?: string[]): Promise<RejudgeResult> {
  const result: RejudgeResult = { photos: 0, unflagged: 0, places: 0, descriptions: 0, broad: [] };
  const all = names ?? (await knownNames());
  const patterns = all.flatMap(namePatterns);
  const any = nameMatcher(patterns);
  if (!any) return result;

  // First the whole album, to learn which names are really words; only the items that mention one are kept.
  let total = 0;
  const hits: Row[] = [];
  for await (const rows of annotated()) {
    total += rows.length;
    for (const r of rows) if (any(helperText((r.annotation ?? {}) as StoredAnnotation))) hits.push(r);
  }
  const limit = Math.max(BROAD_MIN, Math.ceil(total * BROAD_SHARE));
  const kept: NamePattern[] = [];
  for (const p of patterns) {
    const test = nameMatcher([p])!;
    const n = hits.filter((r) => test(helperText((r.annotation ?? {}) as StoredAnnotation))).length;
    if (n > limit) result.broad.push(p.words.join(" "));
    else kept.push(p);
  }
  // Said without the name itself: how many, and that the album was left alone because of them.
  if (result.broad.length) console.warn(`[rejudge] ${result.broad.length} name form(s) matched more than ${limit} of ${total} described items and were skipped`);
  const test = nameMatcher(kept);
  if (!test) return result;

  for (const r of hits) {
    if ((r.annotationMembersOnly && !r.annotationTitleOnly) || r.annotationSharedAt) continue;
    if (!test(helperText((r.annotation ?? {}) as StoredAnnotation))) continue;
    // Guarded, so a row flagged or shown to everyone since it was read is left as it now is.
    const done = await db.photo.updateMany({ where: { id: r.id, annotationSharedAt: null, OR: [{ annotationMembersOnly: false }, { annotationTitleOnly: true }] }, data: flagData(r, false) });
    result.photos += done.count;
  }

  const guesses = await db.photo.findMany({ where: { gpsSource: "ESTIMATE", placeEstimateMembersOnly: false }, select: { id: true, placeEstimateName: true, placeEstimateNote: true } });
  for (const g of guesses) {
    if (!test([g.placeEstimateName, g.placeEstimateNote].filter(Boolean).join("\n"))) continue;
    result.places += (await db.photo.updateMany({ where: { id: g.id, placeEstimateMembersOnly: false }, data: { placeEstimateMembersOnly: true } })).count;
  }

  const unshown = { description: { not: null }, descriptionSharedAt: null };
  const [trips, collections, activities] = await Promise.all([
    db.trip.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true } }),
    db.collection.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true } }),
    db.activity.findMany({ where: { ...unshown, OR: [{ descriptionMembersOnly: false }, { descriptionTitleOnly: true }] }, select: { id: true, description: true } }),
  ]);
  for (const t of trips) if (test(t.description!)) result.descriptions += (await db.trip.updateMany({ where: { id: t.id, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count;
  for (const c of collections) if (test(c.description!)) result.descriptions += (await db.collection.updateMany({ where: { id: c.id, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count;
  for (const a of activities) if (test(a.description!)) result.descriptions += (await db.activity.updateMany({ where: { id: a.id, descriptionSharedAt: null, OR: [{ descriptionMembersOnly: false }, { descriptionTitleOnly: true }] }, data: { descriptionMembersOnly: true, descriptionTitleOnly: false } })).count;
  return result;
}

/**
 * Title words: for the photographs in one trip or collection (or all of them), flag the helper's text that repeats a
 * word of a title strangers cannot open, and lift the flag from text whose only reason was a title that is now
 * public. A trip's activities' descriptions are judged against the trip's title the same way.
 */
export async function rejudgeTitles(scope: { tripId?: string; collectionId?: string } = {}): Promise<RejudgeResult> {
  const result: RejudgeResult = { photos: 0, unflagged: 0, places: 0, descriptions: 0, broad: [] };
  const where = scope.tripId ? { tripId: scope.tripId } : scope.collectionId ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  for await (const rows of annotated(where)) {
    for (const r of rows) {
      if (r.annotationSharedAt) continue;
      const hit = mentionsAnyTitle(helperText((r.annotation ?? {}) as StoredAnnotation), privateTitles(r));
      if (hit && !r.annotationMembersOnly) {
        result.photos += (await db.photo.updateMany({ where: { id: r.id, annotationMembersOnly: false, annotationSharedAt: null }, data: flagData(r, true) })).count;
      } else if (!hit && r.annotationMembersOnly && r.annotationTitleOnly) {
        result.unflagged += (await db.photo.updateMany({ where: { id: r.id, annotationTitleOnly: true }, data: unflagData(r) })).count;
      }
    }
  }
  if (scope.collectionId) return result;
  const activities = await db.activity.findMany({
    where: { ...(scope.tripId ? { tripId: scope.tripId } : {}), description: { not: null }, descriptionSharedAt: null },
    select: { id: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, trip: { select: { title: true, visibility: true } } },
  });
  for (const a of activities) {
    const hit = a.trip.visibility !== "PUBLIC" && mentionsAnyTitle(a.description!, [a.trip.title]);
    if (hit && !a.descriptionMembersOnly) result.descriptions += (await db.activity.updateMany({ where: { id: a.id, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: true } })).count;
    else if (!hit && a.descriptionTitleOnly) result.descriptions += (await db.activity.updateMany({ where: { id: a.id, descriptionTitleOnly: true }, data: { descriptionMembersOnly: false, descriptionTitleOnly: false } })).count;
  }
  return result;
}

/**
 * Ask for a judging, from whatever changed: a name, or a trip's or collection's visibility. One at a time per thing
 * asked about, so pressing save twice is one pass.
 */
export async function enqueueRejudge(job: RejudgeJob): Promise<void> {
  const key = job.tripId ? `trip:${job.tripId}` : job.collectionId ? `collection:${job.collectionId}` : job.names ? `names:${[...job.names].sort().join("|")}` : "all";
  await enqueue(QUEUES.rejudgeText, job, { singletonKey: `rejudge:${key}`.slice(0, 200), singletonSeconds: 10 });
}

/**
 * Queue a judging from an action, without letting a queue that is down fail what the member asked for: what was
 * written before stays as it was until the next start of the worker judges the whole album again.
 */
export async function rejudgeLater(job: RejudgeJob): Promise<void> {
  await enqueueRejudge(job).catch((err) => console.error("[rejudge] could not queue", err instanceof Error ? err.message : err));
}

/** The job: one trip's or collection's title words, the names given, or — with nothing given — all of it. */
export async function rejudgeText(job: RejudgeJob): Promise<RejudgeResult> {
  if (job.tripId || job.collectionId) return rejudgeTitles({ tripId: job.tripId, collectionId: job.collectionId });
  const names = await rejudgeNames(job.names);
  if (job.names) return names;
  const titles = await rejudgeTitles();
  return { photos: names.photos + titles.photos, unflagged: titles.unflagged, places: names.places, descriptions: names.descriptions + titles.descriptions, broad: names.broad };
}
