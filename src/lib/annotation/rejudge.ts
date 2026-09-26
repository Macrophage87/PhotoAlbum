import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { StoredAnnotation } from "./schema";
import { helperText, knownNames, pastHelperTitles, titleIsHelpers } from "./members-only";
import { mentionsAnyTitle, nameMatcher, namePatterns } from "./names";

/**
 * Judging again what was written before something changed.
 *
 * The helper's text, its place guesses and descriptions are judged when they are written (see `members-only.ts`).
 * Two things can change afterwards: a name becomes known (somebody is added, tagged under a new name, renamed, or a
 * member sets their name), and a trip or collection changes title or visibility, which decides whether a word from
 * its title gives anything away. Both are answered here, in the background and in batches, never inside the request
 * that made the change, and by the same rule as at writing (`names.ts`): a name that is also an everyday word is only
 * ever matched with a capital, so nothing is skipped for being common. The children and the dog are the most named
 * of all, and the ones most worth keeping in the family.
 *
 * What it will not do: move a title the family typed (see `titleIsHelpers`), touch anything a member chose to show
 * to everyone (`annotationSharedAt`, `descriptionSharedAt`) — that stays shown until it is written again — or change
 * a row that was rewritten since it was read: every write is guarded by the `updatedAt` it read.
 */
export type RejudgeJob = { names?: string[]; tripId?: string; collectionId?: string; sweep?: boolean };

export type RejudgeResult = { photos: number; titles: number; unflagged: number; places: number; descriptions: number };

const empty = (): RejudgeResult => ({ photos: 0, titles: 0, unflagged: 0, places: 0, descriptions: 0 });

/** Bump when the rules in names.ts or the ones here change: the next sweep then judges the whole album again. */
export const MATCHER_VERSION = "2026-09-26.4";

const BATCH = 500;

type Row = { id: string; updatedAt: Date; kind: string; context: string | null; title: string | null; titleByHelper: boolean | null; membersTitle: string | null; annotation: unknown; annotationMembersOnly: boolean; annotationTitleOnly: boolean; annotationSharedAt: Date | null; trip: { title: string; visibility: string } | null; collections: { collection: { title: string; visibility: string } }[] };

const rowSelect = { id: true, updatedAt: true, kind: true, context: true, title: true, titleByHelper: true, membersTitle: true, annotation: true, annotationMembersOnly: true, annotationTitleOnly: true, annotationSharedAt: true, trip: { select: { title: true, visibility: true } }, collections: { select: { collection: { select: { title: true, visibility: true } } } } } as const;

/** Lets a request in between batches: the worker may share its process with the web server. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every annotated photograph (or those in one trip or collection), a batch at a time; nothing is kept between them. */
async function* annotated(where: Prisma.PhotoWhereInput = {}): AsyncGenerator<Row[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows: Row[] = await db.photo.findMany({ where: { NOT: { annotation: { equals: Prisma.DbNull } }, ...where }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: rowSelect });
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
    await breathe();
  }
}

const aiTitleOf = (r: Pick<Row, "annotation" | "kind">) => (r.kind === "EXTERNAL_VIDEO" ? null : ((r.annotation as StoredAnnotation | null)?.title ?? "").trim() || null);

/** The title fields once the item is members-only: the helper's title (see `titleIsHelpers`) comes off it. */
async function titleData(r: Row, names: ((text: string) => boolean) | null): Promise<{ title?: null; membersTitle?: string; titleByHelper?: null }> {
  if (r.kind === "EXTERNAL_VIDEO") return {};
  const ai = aiTitleOf(r);
  const own = r.title?.trim() || null;
  const unknown = own && r.titleByHelper === null && own !== ai;
  const helpers = titleIsHelpers({ title: r.title, titleByHelper: r.titleByHelper, aiTitle: ai, ...(unknown ? { pastTitles: await pastHelperTitles(r.id), namesSomebody: Boolean(names?.(own!)) } : {}) });
  const kept = r.membersTitle?.trim() || null;
  if (helpers) return { title: null, titleByHelper: null, ...(kept ? {} : { membersTitle: ai ?? own! }) };
  return ai && !kept ? { membersTitle: ai } : {};
}

/** Guarded write: only if the row is as it was read. */
const unchanged = (r: Pick<Row, "id" | "updatedAt">) => ({ id: r.id, updatedAt: r.updatedAt });

/** A photograph flagged, or already flagged, by this pass: flag it and take the helper's title off it. */
export async function flagPhoto(r: Row, titleOnly: boolean, names: ((text: string) => boolean) | null): Promise<number> {
  const data = { annotationMembersOnly: true, annotationTitleOnly: r.annotationMembersOnly ? r.annotationTitleOnly && titleOnly : titleOnly, ...(await titleData(r, names)) };
  return (await db.photo.updateMany({ where: { ...unchanged(r), annotationSharedAt: null }, data })).count;
}

/**
 * Names: flag what mentions them and is not members-only yet (or is only because of a title word, which a name
 * outranks), and take the helper's titles off members-only items. `names` absent means everybody the album knows.
 */
export async function rejudgeNames(names?: string[]): Promise<RejudgeResult> {
  const result = empty();
  const test = nameMatcher((names ?? (await knownNames())).flatMap(namePatterns));
  if (!test) return result;
  for await (const rows of annotated()) {
    for (const r of rows) {
      if (r.annotationSharedAt) continue;
      const named = test(helperText((r.annotation ?? {}) as StoredAnnotation));
      const hard = r.annotationMembersOnly && !r.annotationTitleOnly;
      if (named && !hard) {
        result.photos += await flagPhoto(r, false, test);
      } else if (r.annotationMembersOnly && r.title?.trim() && r.titleByHelper !== false) {
        // Already members-only, and a title that may be the helper's is still on it.
        const data = await titleData(r, test);
        if ("title" in data) result.titles += (await db.photo.updateMany({ where: { ...unchanged(r), annotationMembersOnly: true }, data })).count;
      }
    }
  }

  let cursor: string | null = null;
  for (;;) {
    const guesses: { id: string; updatedAt: Date; placeEstimateName: string | null; placeEstimateNote: string | null }[] = await db.photo.findMany({ where: { gpsSource: "ESTIMATE", placeEstimateMembersOnly: false }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, updatedAt: true, placeEstimateName: true, placeEstimateNote: true } });
    if (!guesses.length) break;
    for (const g of guesses) {
      if (test([g.placeEstimateName, g.placeEstimateNote].filter(Boolean).join("\n"))) result.places += (await db.photo.updateMany({ where: { ...unchanged(g), placeEstimateMembersOnly: false }, data: { placeEstimateMembersOnly: true } })).count;
    }
    cursor = guesses[guesses.length - 1].id;
    await breathe();
  }

  const unshown = { description: { not: null }, descriptionSharedAt: null };
  const select = { id: true, updatedAt: true, description: true } as const;
  const [trips, collections, activities] = await Promise.all([
    db.trip.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select }),
    db.collection.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select }),
    db.activity.findMany({ where: { ...unshown, OR: [{ descriptionMembersOnly: false }, { descriptionTitleOnly: true }] }, select }),
  ]);
  for (const t of trips) if (test(t.description!)) result.descriptions += (await db.trip.updateMany({ where: { ...unchanged(t), descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count;
  for (const c of collections) if (test(c.description!)) result.descriptions += (await db.collection.updateMany({ where: { ...unchanged(c), descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count;
  for (const a of activities) if (test(a.description!)) result.descriptions += (await db.activity.updateMany({ where: { ...unchanged(a), descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: false } })).count;
  return result;
}

/** Titles of the trip and collections a photograph is in that strangers cannot open. */
const privateTitles = (r: Row) => [r.trip, ...r.collections.map((c) => c.collection)].flatMap((c) => (c && c.visibility !== "PUBLIC" ? [c.title] : []));

/**
 * Title words: for the photographs in one trip or collection (or all of them), flag the helper's text that repeats a
 * word of a title strangers cannot open. A flag held only for a title word is lifted only when that very trip or
 * collection has become public, and only where no other private title is repeated: a renamed trip keeps what its old
 * title put in the words, and so does a photograph that left a private trip. A trip's activities' descriptions are
 * judged against the trip's title the same way.
 */
export async function rejudgeTitles(scope: { tripId?: string; collectionId?: string } = {}): Promise<RejudgeResult> {
  const result = empty();
  const where: Prisma.PhotoWhereInput = scope.tripId ? { tripId: scope.tripId } : scope.collectionId ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  const container = scope.tripId
    ? await db.trip.findUnique({ where: { id: scope.tripId }, select: { visibility: true } })
    : scope.collectionId
      ? await db.collection.findUnique({ where: { id: scope.collectionId }, select: { visibility: true } })
      : null;
  const madePublic = container?.visibility === "PUBLIC";
  // Lifting is the one thing that shows text to strangers, so it asks everything else first: a name the album knows
  // (its own judging may not have run yet), the notes, anybody tagged. Only the title word may have been the reason.
  const names = madePublic ? nameMatcher((await knownNames()).flatMap(namePatterns)) : null;
  const liftable = async (r: Row, text: string) => !r.context?.trim() && !names?.(text) && !(await tagged(r.id));
  for await (const rows of annotated(where)) {
    for (const r of rows) {
      if (r.annotationSharedAt) continue;
      const text = helperText((r.annotation ?? {}) as StoredAnnotation);
      const hit = mentionsAnyTitle(text, privateTitles(r));
      if (hit && !r.annotationMembersOnly) {
        result.photos += await flagPhoto(r, true, null);
      } else if (madePublic && !hit && r.annotationMembersOnly && r.annotationTitleOnly) {
        if (!(await liftable(r, text))) {
          // Something stronger than a title word holds it now: it stays, and no longer for the title alone.
          await db.photo.updateMany({ where: { ...unchanged(r), annotationTitleOnly: true }, data: { annotationTitleOnly: false } });
          continue;
        }
        const ai = aiTitleOf(r);
        const back = ai && !r.title?.trim() && r.membersTitle?.trim() === ai;
        result.unflagged += (await db.photo.updateMany({ where: { ...unchanged(r), annotationTitleOnly: true }, data: { annotationMembersOnly: false, annotationTitleOnly: false, ...(back ? { title: ai, membersTitle: null, titleByHelper: true } : {}) } })).count;
      }
    }
  }
  if (scope.collectionId) return result;
  const activities = await db.activity.findMany({
    where: { ...(scope.tripId ? { tripId: scope.tripId } : {}), description: { not: null }, descriptionSharedAt: null },
    select: { id: true, updatedAt: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, trip: { select: { title: true, visibility: true } } },
  });
  for (const a of activities) {
    const hit = a.trip.visibility !== "PUBLIC" && mentionsAnyTitle(a.description!, [a.trip.title]);
    if (hit && !a.descriptionMembersOnly) result.descriptions += (await db.activity.updateMany({ where: { ...unchanged(a), descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: true } })).count;
    else if (madePublic && !hit && a.descriptionTitleOnly) {
      const named = Boolean(names?.(a.description!));
      result.descriptions += (await db.activity.updateMany({ where: { ...unchanged(a), descriptionTitleOnly: true }, data: named ? { descriptionTitleOnly: false } : { descriptionMembersOnly: false, descriptionTitleOnly: false } })).count;
    }
  }
  return result;
}

async function tagged(photoId: string): Promise<boolean> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  return Boolean(face || animal);
}

const add = (a: RejudgeResult, b: RejudgeResult): RejudgeResult => ({ photos: a.photos + b.photos, titles: a.titles + b.titles, unflagged: a.unflagged + b.unflagged, places: a.places + b.places, descriptions: a.descriptions + b.descriptions });

/**
 * The sweep, run when the worker starts and every night: the whole album when the rules have changed since the last
 * one, otherwise only the names the album has learned since (a rename whose job could not be queued included).
 */
export async function rejudgeSweep(): Promise<RejudgeResult> {
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyMatcher: true, membersOnlyNames: true, membersOnlyJudgedAt: true } });
  const names = [...new Set((await knownNames()).map((n) => n.trim()).filter(Boolean))];
  const judged = new Set(setting?.membersOnlyNames ?? []);
  let result = empty();
  if (setting?.membersOnlyMatcher !== MATCHER_VERSION) {
    result = add(await rejudgeNames(names), await rejudgeTitles());
  } else {
    const fresh = names.filter((n) => !judged.has(n));
    if (fresh.length) result = await rejudgeNames(fresh);
    // A trip or collection retitled or re-shared since, whose own job could not be queued.
    const since = setting?.membersOnlyJudgedAt ?? new Date(0);
    const [trips, collections] = await Promise.all([
      db.trip.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
      db.collection.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
    ]);
    for (const t of trips) result = add(result, await rejudgeTitles({ tripId: t.id }));
    for (const c of collections) result = add(result, await rejudgeTitles({ collectionId: c.id }));
  }
  const done = { membersOnlyMatcher: MATCHER_VERSION, membersOnlyNames: names, membersOnlyJudgedAt: new Date() };
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", ...done }, update: done });
  return result;
}

/** Remember that these names have been judged, so the next sweep does not judge them again. */
async function noteJudged(names: string[]): Promise<void> {
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyNames: true } });
  if (!setting) return;
  const all = [...new Set([...setting.membersOnlyNames, ...names.map((n) => n.trim()).filter(Boolean)])];
  await db.appSetting.update({ where: { id: "app" }, data: { membersOnlyNames: all } });
}

/**
 * Ask for a judging, from whatever changed: a name, or a trip's or collection's title or visibility. One at a time
 * per thing asked about, so pressing save twice is one pass — and a second change inside the same ten seconds is
 * queued for the next slot rather than dropped (a trip made public and private again must be judged twice).
 */
export async function enqueueRejudge(job: RejudgeJob): Promise<void> {
  const key = job.sweep ? "sweep" : job.tripId ? `trip:${job.tripId}` : job.collectionId ? `collection:${job.collectionId}` : job.names ? `names:${[...job.names].sort().join("|")}` : "all";
  await enqueue(QUEUES.rejudgeText, job, { singletonKey: `rejudge:${key}`.slice(0, 200), singletonSeconds: 10, singletonNextSlot: true, retryLimit: 3, retryDelay: 30 });
}

/**
 * Queue a judging from an action, without letting a queue that is down fail what the member asked for. Tried a few
 * times; if it still cannot be queued, the nightly sweep picks the change up (it judges any name it has not seen),
 * and the answer says so, so the page can tell the member.
 */
export async function rejudgeLater(job: RejudgeJob): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await enqueueRejudge(job);
      return true;
    } catch (err) {
      if (attempt === 2) console.error("[rejudge] could not queue", err instanceof Error ? err.message : err);
      else await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return false;
}

/** The job: the sweep, one trip's or collection's title words, the names given, or — with nothing given — all of it. */
export async function rejudgeText(job: RejudgeJob): Promise<RejudgeResult> {
  if (job.sweep) return rejudgeSweep();
  if (job.tripId || job.collectionId) return rejudgeTitles({ tripId: job.tripId, collectionId: job.collectionId });
  const names = await rejudgeNames(job.names);
  if (job.names) {
    await noteJudged(job.names);
    return names;
  }
  return add(names, await rejudgeTitles());
}
