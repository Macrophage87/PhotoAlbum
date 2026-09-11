"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueueMatch } from "@/lib/jobs/handlers/match-photo";
import { env } from "@/lib/env";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { annotationGates } from "@/lib/annotation/eligibility";
import { estimateCost, type Estimate } from "@/lib/annotation/pricing";
import { BACKFILL_CAP, backfillCandidates, backfillExclusions, type BackfillScope } from "@/lib/jobs/handlers/annotation-batch";
import { annotationSchema, toStored, type StoredAnnotation } from "@/lib/annotation/schema";
import { anthropic } from "@/lib/annotation/client";

async function requireAdminOrThrow() {
  const user = await requireUserOrThrow();
  if (user.role !== "ADMIN") throw new Error("Admins only");
  return user;
}

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
  await requireUserOrThrow();
  const res = await db.photo.updateMany({ where: { id: { in: ids.parse(photoIds) } }, data: { annotationOptOut: optOut } });
  revalidatePath("/", "layout");
  return res.count;
}

/** A whole trip or collection can be marked as never leaving the server; its items inherit it. */
export async function setContainerAnnotationOptOut(kind: "trip" | "collection", id: string, optOut: boolean): Promise<void> {
  await requireUserOrThrow();
  if (kind === "trip") await db.trip.update({ where: { id }, data: { annotationOptOut: optOut } });
  else await db.collection.update({ where: { id }, data: { annotationOptOut: optOut } });
  revalidatePath("/", "layout");
}

export async function reannotate(photoId: string): Promise<void> {
  await requireUserOrThrow();
  const gates = await annotationGates();
  if (!gates.active) throw new Error("Annotation is off");
  await db.photo.update({ where: { id: photoId }, data: { annotatedAt: null, annotationError: null } });
  await enqueue(QUEUES.annotatePhoto, { photoId }, { singletonKey: `annotate:${photoId}`, singletonSeconds: 60 });
  revalidatePath(`/photos/${photoId}`);
}

const editSchema = annotationSchema.omit({ estimatedYear: true }).partial();

/** A member's edit of the helper's text; from then on re-annotation never overwrites it. */
export async function updateAnnotation(photoId: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { annotation: true } });
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
  });
  await db.photo.update({ where: { id: photoId }, data: { annotation: merged, annotationSource: "EDITED" } });
  revalidatePath(`/photos/${photoId}`);
}

/** Turn the helper's estimate (or the member's own) into the item's real date. */
export async function confirmEstimatedDate(photoId: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
  await db.photo.update({ where: { id: photoId }, data: { takenAt: new Date(`${day}T12:00:00Z`), takenAtSource: "MANUAL", tzOffsetMin: 0, estimatedDateSource: "MEMBER", estimatedDateNote: null, estimatedDateConfidence: null } });
  await enqueueMatch([photoId]);
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/review");
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("trip"), tripId: z.string().min(1) }),
  z.object({ kind: z.literal("collection"), collectionId: z.string().min(1) }),
  z.object({ kind: z.literal("range"), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export type BackfillPreview = { estimate: Estimate; photos: number; videos: number; sends: string[]; /** What in scope is left out, and why. */ excluded: { inScope: number; described: number; optedOutSelf: number; optedOutInherited: number }; /** Set when the scope holds more than one run sends. */ cap: number | null };

/** What a backfill would send and roughly what it would cost, before anything is submitted. */
export async function previewBackfill(scope: BackfillScope): Promise<BackfillPreview> {
  await requireAdminOrThrow();
  const s = scopeSchema.parse(scope);
  const items = await backfillCandidates(s);
  const videos = items.filter((i) => i.kind === "VIDEO").length;
  const photos = items.length - videos;
  const excluded = await backfillExclusions(s);
  return {
    estimate: estimateCost(env().ANNOTATION_MODEL, { photos, videos }, { batch: true }),
    photos,
    videos,
    excluded,
    cap: excluded.inScope - excluded.described - excluded.optedOutSelf - excluded.optedOutInherited > BACKFILL_CAP ? BACKFILL_CAP : null,
    sends: ["the 1600-pixel rendition of each photo (three or four frames for a clip)", "the uploader's notes, caption and title", "the date and camera when known", "the trip and collection titles", "the names of confirmed people whose recognition is on and who are adults, and confirmed pet names; never face data"],
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
  const batch = await db.annotationBatch.create({ data: { id, anthropicBatchId: `pending-${id}`, scope: s, requested: items.length, createdById: admin.id } });
  // A full run can take hours of building and uploading; the job must not expire meanwhile. One late retry lets a
  // run cut short by a crash be closed by the handler as well as by the poll.
  await enqueue(QUEUES.annotationBackfill, { batchId: batch.id }, { expireInSeconds: 12 * 3600, retryLimit: 1, retryDelay: 3600, retryBackoff: false });
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
