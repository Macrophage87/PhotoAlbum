import { db } from "@/lib/db";
import { anthropic } from "@/lib/annotation/client";
import { annotationGates } from "@/lib/annotation/eligibility";
import { buildRequest, loadItem } from "@/lib/annotation/request";
import { applyAnnotation, parseMessageContent, recordFailure } from "@/lib/annotation/apply";
import { enqueue } from "../boss";
import { QUEUES, type AnnotationBackfillJob } from "../queues";

export type BackfillScope = { kind: "all" } | { kind: "trip"; tripId: string } | { kind: "collection"; collectionId: string } | { kind: "range"; from: string; to: string };

/** Items a backfill would send: in scope, never annotated, not opted out directly or by inheritance. */
export async function backfillCandidates(scope: BackfillScope) {
  const base = {
    status: "READY" as const,
    annotatedAt: null,
    annotationOptOut: false,
    OR: [{ tripId: null }, { trip: { annotationOptOut: false } }],
    collections: { none: { collection: { annotationOptOut: true } } },
  };
  const where =
    scope.kind === "trip" ? { ...base, tripId: scope.tripId }
    : scope.kind === "collection" ? { ...base, collections: { ...base.collections, some: { collectionId: scope.collectionId } } }
    : scope.kind === "range" ? { ...base, takenAt: { gte: new Date(`${scope.from}T00:00:00Z`), lte: new Date(`${scope.to}T23:59:59Z`) } }
    : base;
  return db.photo.findMany({ where, select: { id: true, kind: true }, orderBy: { createdAt: "asc" }, take: 10_000 });
}

/** Submit one Message Batch for the scope. Results are collected by the poll job. */
export async function annotationBackfill(job: AnnotationBackfillJob): Promise<void> {
  const gates = await annotationGates();
  if (!gates.active) return;
  const batch = await db.annotationBatch.findUnique({ where: { id: job.batchId } });
  if (!batch || batch.status !== "SUBMITTED" || !batch.anthropicBatchId.startsWith("pending-")) return;
  const candidates = await backfillCandidates(batch.scope as BackfillScope);
  const requests = [];
  let skipped = 0;
  for (const c of candidates) {
    const item = await loadItem(c.id);
    if (!item) { skipped++; continue; }
    try {
      requests.push({ custom_id: c.id, params: await buildRequest(item, gates.model, []) });
    } catch {
      skipped++;
    }
  }
  if (!requests.length) {
    await db.annotationBatch.update({ where: { id: batch.id }, data: { status: "ENDED", skipped, endedAt: new Date(), anthropicBatchId: `empty-${batch.id}` } });
    return;
  }
  const created = await anthropic().messages.batches.create({ requests });
  console.log(`[annotation-backfill] batch ${created.id} submitted with ${requests.length} requests (${skipped} skipped)`);
  await db.annotationBatch.update({ where: { id: batch.id }, data: { anthropicBatchId: created.id, requested: requests.length, skipped } });
  // First poll soon after submission; the five-minute schedule takes over from there.
  await enqueue(QUEUES.annotationBatchPoll, {}, { startAfter: 5, singletonKey: "annotation-batch-poll", singletonSeconds: 5 });
}

/** Poll open batches; apply each result, validating by hand since `parse` does not apply to batch results. */
export async function annotationBatchPoll(): Promise<void> {
  const open = (await db.annotationBatch.findMany({ where: { status: "SUBMITTED" } })).filter((b) => !b.anthropicBatchId.startsWith("pending-") && !b.anthropicBatchId.startsWith("empty-"));
  for (const b of open) {
    const remote = await anthropic().messages.batches.retrieve(b.anthropicBatchId).catch(() => null);
    if (!remote) continue;
    if (remote.processing_status !== "ended") continue;
    let succeeded = 0, errored = 0;
    for await (const result of await anthropic().messages.batches.results(b.anthropicBatchId)) {
      const photoId = result.custom_id;
      if (result.result.type !== "succeeded") {
        errored++;
        await recordFailure(photoId, `batch:${result.result.type}`);
        continue;
      }
      const message = result.result.message;
      if (message.stop_reason === "refusal") {
        errored++;
        await recordFailure(photoId, `refusal:${message.stop_details?.category ?? "unspecified"}`);
        continue;
      }
      const parsed = parseMessageContent(message.content as { type: string; text?: string }[]);
      if (!parsed) {
        errored++;
        await recordFailure(photoId, "invalid_output");
        continue;
      }
      await applyAnnotation(photoId, message.model, parsed, { content: message.content, usage: message.usage, stop_reason: message.stop_reason });
      succeeded++;
    }
    console.log(`[annotation-backfill] batch ${b.anthropicBatchId} ended: ${succeeded} ok, ${errored} failed`);
    await db.annotationBatch.update({ where: { id: b.id }, data: { status: remote.request_counts.canceled ? "CANCELLED" : "ENDED", succeeded, errored, endedAt: new Date() } });
  }
}
