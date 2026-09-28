"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { enqueueMatch } from "@/lib/jobs/handlers/match-photo";
import { env } from "@/lib/env";
import { requireAdminOrThrow, requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditContainer, canEditMedia, editableMediaIds, NOT_YOURS, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { annotationGates } from "@/lib/annotation/eligibility";
import { estimateCost, TOKENS_PER_PLACE, type Estimate } from "@/lib/annotation/pricing";
import { BACKFILL_CAP, backfillCandidates, backfillExclusions, taskOf, type BackfillScope, type BackfillTask } from "@/lib/jobs/handlers/annotation-batch";
import { annotationSchema, toStored, type StoredAnnotation } from "@/lib/annotation/schema";
import { anthropic } from "@/lib/annotation/client";
import { helperText, judgeHelperText, knownNames, knownNamesLook, mentionsAnyName, pastHelperTitles, sameTitle, titleIsHelpers, unknownTitleAside, warnStuckTitle } from "@/lib/annotation/members-only";
import { enqueueEmbedding, refreshTextEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { NAME_NOT_TO_BE_SHOWN, withoutWithdrawnNames } from "@/lib/people/forget";
import { dbNow } from "@/lib/people/names-changed";
import { nameCheckForPhoto } from "@/lib/people/name-check";
import { noteRelaxedRelease } from "@/lib/annotation/relaxed-release";

/** The admin's half of the two gates. Recorded with who and when so the decision is auditable. */
export async function setAnnotationOptIn(on: boolean): Promise<void> {
  const admin = await requireAdminOrThrow();
  await db.appSetting.upsert({
    where: { id: "app" },
    create: { id: "app", annotationOptInAt: on ? new Date() : null, annotationOptInById: on ? admin.id : null },
    update: { annotationOptInAt: on ? new Date() : null, annotationOptInById: on ? admin.id : null },
  });
  revalidatePath("/admin");
  revalidatePath("/privacy");
}

const ids = z.array(z.string().min(1)).min(1).max(500);

/** Keep these items away from the helper (or allow them again). Setting it cancels any queued job by way of the gate in the handler. */
export async function setAnnotationOptOut(photoIds: string[], optOut: boolean): Promise<number> {
  const user = await requireUserOrThrow();
  // Whether a picture is sent to the helper is the uploader's call, and an admin's.
  const mine = await editableMediaIds(user, ids.parse(photoIds));
  if (!mine.length) return 0;
  const res = await db.photo.updateMany({ where: { id: { in: mine } }, data: { annotationOptOut: optOut } });
  revalidatePath("/", "layout");
  return res.count;
}

/** A whole trip or collection can be marked as never leaving the server; its items inherit it. */
export async function setContainerAnnotationOptOut(kind: "trip" | "collection", id: string, optOut: boolean): Promise<void> {
  const user = await requireUserOrThrow();
  const container = kind === "trip"
    ? await db.trip.findUnique({ where: { id }, select: { createdById: true } })
    : await db.collection.findUnique({ where: { id }, select: { createdById: true } });
  if (!container) return;
  if (!canEditContainer(user, container)) throw new Error(NOT_YOUR_CONTAINER);
  if (kind === "trip") await db.trip.update({ where: { id }, data: { annotationOptOut: optOut } });
  else await db.collection.update({ where: { id }, data: { annotationOptOut: optOut } });
  revalidatePath("/", "layout");
}

/**
 * Ask for a new description now. On one the family edited, `replace` is the member's confirmed "yes, throw ours
 * away": without it the new answer only refreshes the helper's own fields, as every automatic pass does.
 */
export async function reannotate(photoId: string, replace = false): Promise<void> {
  const user = await requireUserOrThrow();
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) return;
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  const gates = await annotationGates();
  if (!gates.active) throw new Error("Annotation is off");
  await db.photo.update({ where: { id: photoId }, data: { annotatedAt: null, annotationError: null } });
  // Its own singleton key, so a pass already queued by the sweep does not swallow the member's request.
  if (replace === true) await enqueue(QUEUES.annotatePhoto, { photoId, replace: true }, { singletonKey: `annotate-replace:${photoId}`, singletonSeconds: 60 });
  else await enqueue(QUEUES.annotatePhoto, { photoId }, { singletonKey: `annotate:${photoId}`, singletonSeconds: 60 });
  revalidatePath(`/photos/${photoId}`);
}

const editSchema = annotationSchema.omit({ estimatedYear: true }).partial();

/** A member's edit of the helper's text; from then on re-annotation never overwrites it. */
export async function updateAnnotation(photoId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) return;
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { annotation: true, annotationMembersOnly: true, annotationTitleOnly: true, annotationTitleWords: true, annotationTitleFrom: true, annotationSharedAt: true, context: true } });
  if (!photo) return;
  const current = (photo.annotation ?? {}) as Partial<StoredAnnotation>;
  const list = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const text = (v: FormDataEntryValue | null) => String(v ?? "").trim() || null;
  const next = editSchema.parse({
    caption: String(fd.get("caption") ?? "").trim(),
    description: String(fd.get("description") ?? "").trim(),
    tags: list(fd.get("tags")),
    place: text(fd.get("place")),
    activity: text(fd.get("activity")),
    objects: list(fd.get("objects")),
    visibleText: text(fd.get("visibleText")),
    mood: text(fd.get("mood")),
  });
  const merged = toStored({
    title: current.title ?? "",
    caption: next.caption ?? current.caption ?? "",
    description: next.description ?? current.description ?? "",
    tags: next.tags ?? current.tags ?? [],
    place: next.place ?? null,
    activity: next.activity ?? null,
    objects: next.objects ?? current.objects ?? [],
    visibleText: next.visibleText ?? null,
    season: current.season ?? "unknown",
    mood: next.mood ?? null,
    searchSummary: current.searchSummary ?? "",
    estimatedYear: null,
    estimatedPlace: null,
  });
  // An edit can add a name as easily as take one out, and never makes members-only text public again; that takes
  // "show it to everyone". Text somebody has shown to everyone is theirs, and is held again only if it now names
  // somebody.
  const judged = photo.annotationSharedAt
    ? { membersOnly: (await knownNamesLook(await nameCheckForPhoto(photoId)))({ texts: [merged.title, merged.caption, merged.description, merged.place], lists: [merged.searchSummary, ...merged.tags], said: helperText(merged) }), titleOnly: false }
    : await judgeHelperText(photoId, merged, photo.context);
  const membersOnly = photo.annotationMembersOnly || judged.membersOnly;
  // Held only for a private title's word before, and nothing stronger now: publishing that trip still lifts it.
  const hard = judged.membersOnly && !judged.titleOnly;
  const titleOnly = photo.annotationMembersOnly ? photo.annotationTitleOnly && !hard : judged.titleOnly;
  await db.photo.update({ where: { id: photoId }, data: { annotation: merged, annotationSource: "EDITED", annotationMembersOnly: membersOnly, annotationTitleOnly: membersOnly && titleOnly,
      // A title-word flag remembers every word and container that ever caused it, so lifting it asks about all of them.
      annotationTitleWords: membersOnly && titleOnly ? [...new Set([...photo.annotationTitleWords, ...(judged.titleWords ?? [])])] : [],
      annotationTitleFrom: membersOnly && titleOnly ? [...new Set([...photo.annotationTitleFrom, ...(judged.titleFrom ?? [])])] : [],
      ...(membersOnly ? { annotationSharedAt: null } : {}) } });
  // Shown only because a relaxed excuse lets it be, or edited so it needs none: marked or cleared (relaxed-release.ts).
  await noteRelaxedRelease(photoId);
  // The caption and description are part of what the item is searched by.
  await refreshTextEmbedding(photoId);
  revalidatePath(`/photos/${photoId}`);
}

const DESCRIPTION_CHANGED = "The description changed; have a look at the new one first.";

/**
 * Show the helper's text for an item (and the title it wrote) to everyone who may see the item, or keep it for the
 * family again. The uploader's or an admin's decision, made after reading it: from then on nothing re-flags it until
 * it is written again.
 */
export async function setAnnotationShared(photoId: string, seenRevision: number, everyone: boolean): Promise<void> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true, kind: true, title: true, titleByHelper: true, membersTitle: true, annotation: true, annotationRevision: true } });
  if (!photo) return;
  if (!canEditMedia(user, photo)) throw new Error(NOT_YOURS);
  // What is shown is what was read: a description written again, or edited, since the page was opened has to be read
  // first. Every change to the text moves its revision on (a database trigger), whoever makes it.
  if (photo.annotationRevision !== seenRevision) throw new Error(DESCRIPTION_CHANGED);
  const ai = photo.kind === "EXTERNAL_VIDEO" ? null : ((photo.annotation as Partial<StoredAnnotation> | null)?.title ?? "").trim() || null;
  const own = photo.title?.trim() || null;
  const kept = photo.membersTitle?.trim() || null;
  let data;
  let scrubbed = false;
  if (everyone) {
    // Nobody whose naming the album withdrew is shown by name: the nightly pass only looks at what was written since.
    const out = await withoutWithdrawnNames(photoId, { annotation: photo.annotation, title: ai });
    // Words that may still name somebody the album may not name (withdrawn, switched off, opted out) stay with the
    // family.
    if (out.hold) throw new Error(NAME_NOT_TO_BE_SHOWN);
    scrubbed = out.changed;
    // The helper's title goes back on the item if it has none of its own.
    data = { annotationMembersOnly: false, annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [], annotationSharedAt: new Date(), ...(out.changed ? { annotation: out.annotation as object } : {}), ...(ai && !own && kept === ai ? { title: out.title, titleByHelper: true, membersTitle: null } : {}) };
  } else {
    const external = photo.kind === "EXTERNAL_VIDEO";
    const unknown = !external && own && photo.titleByHelper === null && !sameTitle(own, ai);
    const helpers = !external && titleIsHelpers({ title: photo.title, titleByHelper: photo.titleByHelper, aiTitle: ai, ...(unknown ? { pastTitles: await pastHelperTitles(photoId) } : {}) });
    // Not provably the helper's but naming somebody: aside for members, never dropped (see `unknownTitleAside`).
    const aside = !helpers && unknown ? unknownTitleAside({ title: photo.title, titleByHelper: photo.titleByHelper, membersTitle: photo.membersTitle, aiTitle: ai, namesSomebody: mentionsAnyName(own!, await knownNames()) }) : null;
    if (aside === "stuck") warnStuckTitle(photoId);
    const titles = helpers ? { title: null, titleByHelper: null, membersTitle: kept ?? ai ?? own } : aside === "move" ? { title: null, titleByHelper: null, membersTitle: photo.title } : ai && !kept ? { membersTitle: ai } : {};
    data = { annotationMembersOnly: true, annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [], annotationSharedAt: null, ...titles };
  }
  const done = await db.photo.updateMany({ where: { id: photoId, annotationRevision: seenRevision }, data });
  if (!done.count) throw new Error(DESCRIPTION_CHANGED);
  await noteRelaxedRelease(photoId);
  if (scrubbed) {
    // The semantic index was made from the words with the name.
    await db.$executeRaw`UPDATE "Photo" SET "textEmbedding" = NULL WHERE id = ${photoId}`;
    await enqueueEmbedding(photoId, true);
  }
  revalidatePath(`/photos/${photoId}`);
  // The title and the words show in galleries, timelines, maps and search results too.
  revalidatePath("/", "layout");
}

/**
 * Turn the helper's estimate (or the member's own) into the item's real date. Only the day is known — the noon is
 * made up — so the day may put it on a trip, and a pin taken from a track at the old time goes, but the made-up hour
 * neither picks an activity nor places it on a track, and a photo kept off every activity stays off.
 */
export async function confirmEstimatedDate(photoId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, uploaderId: true, tripId: true, gpsSource: true, activityId: true, activitySetById: true } });
  if (!photo) return;
  if (!canEditMedia(user, photo)) throw new Error(NOT_YOURS);
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
  await db.photo.update({ where: { id: photoId }, data: { estimatedDateSource: "MEMBER", estimatedDateNote: null, estimatedDateConfidence: null } });
  await applyPhotoInstant(photo, new Date(`${day}T12:00:00Z`), 0, "MANUAL", user.id, { geotag: false, keepActivity: true });
  await enqueueMatch([photoId]);
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/review");
}

const taskSchema = z.enum(["describe", "place", "names"]).optional();
const scopeSchema = z.intersection(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("trip"), tripId: z.string().min(1) }),
    z.object({ kind: z.literal("collection"), collectionId: z.string().min(1) }),
    z.object({ kind: z.literal("range"), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    z.object({ kind: z.literal("person"), personId: z.string().min(1) }),
  ]),
  z.object({ task: taskSchema }),
);

/** What one item costs the run to send, and what the family gets back. */
const PLACE_SENDS = ["the 1600-pixel rendition of each photo (three or four frames for a clip)", "the uploader's notes, caption and title", "the date when known", "the trip and collection titles"];
const DESCRIBE_SENDS = ["the 1600-pixel rendition of each photo (three or four frames for a clip)", "the uploader's notes, caption and title", "the date and camera when known", "the trip and collection titles", "the names of confirmed people whose recognition is on and who are adults, and confirmed pet names; never face data"];

export type BackfillPreview = { estimate: Estimate; task: BackfillTask; photos: number; videos: number; sends: string[]; /** What in scope is left out, and why. */ excluded: { inScope: number; described: number; optedOutSelf: number; optedOutInherited: number }; /** Set when the scope holds more than one run sends. */ cap: number | null };

/** What a backfill would send and roughly what it would cost, before anything is submitted. */
export async function previewBackfill(scope: BackfillScope): Promise<BackfillPreview> {
  await requireAdminOrThrow();
  const s = scopeSchema.parse(scope);
  const items = await backfillCandidates(s);
  const videos = items.filter((i) => i.kind === "VIDEO").length;
  const photos = items.length - videos;
  const excluded = await backfillExclusions(s);
  const task = taskOf(s);
  return {
    estimate: estimateCost(env().ANNOTATION_MODEL, { photos, videos }, { batch: true, shape: task === "place" ? TOKENS_PER_PLACE : undefined }),
    task,
    photos,
    videos,
    excluded,
    cap: excluded.inScope - excluded.described - excluded.optedOutSelf - excluded.optedOutInherited > BACKFILL_CAP ? BACKFILL_CAP : null,
    sends: task === "place" ? PLACE_SENDS : DESCRIBE_SENDS,
  };
}

/** Submit a backfill through the Message Batches API. Requires the admin to type the item count as confirmation. */
export async function startBackfill(scope: BackfillScope, typedConfirmation: string): Promise<string> {
  const admin = await requireAdminOrThrow();
  // One run at a time: items in a batch still processing have no annotatedAt yet and would be sent twice.
  const open = await db.annotationBatch.count({ where: { OR: [{ status: "SUBMITTED" }, { parentId: null, runEndedAt: null, startedAt: { not: null } }] } });
  if (open > 0) throw new Error("A backfill is still in progress; wait until every row of it has ended before starting another.");
  const gates = await annotationGates();
  if (!gates.active) throw new Error("Annotation is off");
  const s = scopeSchema.parse(scope);
  const items = await backfillCandidates(s);
  if (!items.length) throw new Error("Nothing to send in that scope");
  if (typedConfirmation.trim() !== String(items.length)) throw new Error(`Type ${items.length} to confirm`);
  const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // The placeholder is unique per batch so two submissions never collide on the unique column.
  const batch = await db.annotationBatch.create({ data: { id, anthropicBatchId: `pending-${id}`, scope: s, requested: items.length, createdById: admin.id, createdAt: await dbNow() } });
  // A full run can take hours of building and uploading; the job must not expire meanwhile. One late retry lets a
  // run cut short by a crash be closed by the handler as well as by the poll.
  await enqueue(QUEUES.annotationBackfill, { batchId: batch.id }, { expireInSeconds: 12 * 3600, retryLimit: 1, retryDelay: 3600, retryBackoff: false });
  revalidatePath("/admin");
  return batch.id;
}

/** How many descriptions of this person were written before the album could use their name. */
export async function namesWaitingFor(personId: string): Promise<number> {
  await requireUserOrThrow();
  const gates = await annotationGates();
  if (!gates.active) return 0;
  return (await backfillCandidates({ kind: "person", personId, task: "names" })).length;
}

/**
 * Describe this one person's photographs again, now that their name may be used.
 *
 * The same run the Admin page offers, aimed at one person and started from the page where their name was allowed
 * in the first place — which is where somebody actually is when the question arises. It is its own scope rather
 * than the whole library so that agreeing on behalf of one relative does not quietly re-describe everybody's
 * photographs, and it needs no typed confirmation because the count is the person's own and bounded.
 */
export async function refreshNamesFor(personId: string): Promise<string | null> {
  const admin = await requireAdminOrThrow();
  const open = await db.annotationBatch.count({ where: { OR: [{ status: "SUBMITTED" }, { parentId: null, runEndedAt: null, startedAt: { not: null } }] } });
  if (open > 0) throw new Error("A backfill is still in progress; wait until it has ended before starting another.");
  const gates = await annotationGates();
  if (!gates.active) throw new Error("Annotation is off");
  const scope = scopeSchema.parse({ kind: "person", personId, task: "names" });
  const items = await backfillCandidates(scope);
  if (!items.length) return null;
  const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const batch = await db.annotationBatch.create({ data: { id, anthropicBatchId: `pending-${id}`, scope, requested: items.length, createdById: admin.id, createdAt: await dbNow() } });
  await enqueue(QUEUES.annotationBackfill, { batchId: batch.id }, { expireInSeconds: 12 * 3600, retryLimit: 1, retryDelay: 3600, retryBackoff: false });
  revalidatePath(`/people/${personId}`);
  revalidatePath("/admin");
  return batch.id;
}

/**
 * Cancel a backfill run: the request is recorded on the row the admin started (so the worker stops between chunks
 * whatever the rows' states), every open row of the family is flipped first and only then, from the fresh row,
 * cancelled at Anthropic when a batch is in flight. Results of requests that had completed are still applied by the
 * poll job (they were billed), which is when such a row's end time is set.
 */
export async function cancelBackfill(batchId: string): Promise<void> {
  await requireAdminOrThrow();
  const batch = await db.annotationBatch.findUnique({ where: { id: batchId }, select: { id: true, parentId: true } });
  if (!batch) return;
  const originId = batch.parentId ?? batch.id;
  await db.annotationBatch.updateMany({ where: { id: originId, cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
  const family = await db.annotationBatch.findMany({ where: { OR: [{ id: originId }, { parentId: originId }], status: "SUBMITTED" }, select: { id: true } });
  for (const row of family) {
    const flipped = await db.annotationBatch.updateMany({ where: { id: row.id, status: "SUBMITTED" }, data: { status: "CANCELLED", endedAt: new Date() } });
    if (flipped.count === 0) continue;
    const fresh = await db.annotationBatch.findUnique({ where: { id: row.id }, select: { anthropicBatchId: true } });
    const live = Boolean(fresh && !fresh.anthropicBatchId.startsWith("pending") && !fresh.anthropicBatchId.startsWith("empty"));
    if (live && fresh) {
      await anthropic().messages.batches.cancel(fresh.anthropicBatchId).catch(() => {});
      await db.annotationBatch.update({ where: { id: row.id }, data: { endedAt: null } });
    }
  }
  revalidatePath("/admin");
}
