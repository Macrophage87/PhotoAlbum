import { db } from "@/lib/db";
import { anthropic } from "@/lib/annotation/client";
import { annotationGates } from "@/lib/annotation/eligibility";
import { buildRequest, loadItem } from "@/lib/annotation/request";
import { applyAnnotation, parseMessageContent, recordFailure } from "@/lib/annotation/apply";
import { enqueue } from "../boss";
import { QUEUES, type AnnotationBackfillJob } from "../queues";
import { permittedNames } from "@/lib/people/gates";

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

/** Items per Message Batch: keeps each request body well under the API's size cap and worker memory flat. */
export const BATCH_CHUNK = 200;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Submit the scope as a series of Message Batches of BATCH_CHUNK items, building each chunk's requests just before
 * it is sent. The first chunk reuses the placeholder row; later chunks get their own rows. Cancelling the placeholder
 * stops further chunks from being submitted. Results are collected by the poll job.
 */
export async function annotationBackfill(job: AnnotationBackfillJob): Promise<void> {
  const gates = await annotationGates();
  if (!gates.active) return;
  const batch = await db.annotationBatch.findUnique({ where: { id: job.batchId } });
  if (!batch || batch.status !== "SUBMITTED" || !batch.anthropicBatchId.startsWith("pending-")) return;
  const candidates = await backfillCandidates(batch.scope as BackfillScope);
  const chunks = chunk(candidates, BATCH_CHUNK);
  let rowId = batch.id;
  let submittedAny = false;
  try {
    for (const [i, part] of chunks.entries()) {
      // A cancel on the original row (or on any chunk row) stops the rest of the scope.
      const current = await db.annotationBatch.findUnique({ where: { id: rowId }, select: { status: true } });
      if (!current || current.status === "CANCELLED") return;
      const requests = [];
      let skipped = 0;
      for (const c of part) {
        const item = await loadItem(c.id);
        if (!item) { skipped++; continue; }
        try {
          requests.push({ custom_id: c.id, params: await buildRequest(item, gates.model, await permittedNames(item.id)) });
        } catch {
          skipped++;
        }
      }
      if (i > 0) rowId = (await db.annotationBatch.create({ data: { anthropicBatchId: `pending-${batch.id}-${i}`, scope: batch.scope as object, requested: 0, createdById: batch.createdById }, select: { id: true } })).id;
      if (!requests.length) {
        await db.annotationBatch.update({ where: { id: rowId }, data: { status: "ENDED", skipped, endedAt: new Date(), anthropicBatchId: `empty-${rowId}` } });
        continue;
      }
      const created = await anthropic().messages.batches.create({ requests });
      submittedAny = true;
      console.log(`[annotation-backfill] batch ${created.id} submitted with ${requests.length} requests (${skipped} skipped), chunk ${i + 1}/${chunks.length}`);
      await db.annotationBatch.update({ where: { id: rowId }, data: { anthropicBatchId: created.id, requested: requests.length, skipped } });
    }
  } catch (err) {
    // A chunk that cannot be submitted marks its row failed rather than leaving a placeholder that polls forever.
    await db.annotationBatch.update({ where: { id: rowId }, data: { status: "FAILED", endedAt: new Date() } }).catch(() => {});
    console.error(`[annotation-backfill] ${rowId} failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return;
  }
  // First poll soon after submission; the five-minute schedule takes over from there.
  if (submittedAny) await enqueue(QUEUES.annotationBatchPoll, {}, { startAfter: 5, singletonKey: "annotation-batch-poll", singletonSeconds: 5 });
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
        // Errored or expired: the helper never saw the item, so leave it eligible for a later backfill.
        errored++;
        await recordFailure(photoId, `batch:${result.result.type}`, { terminal: false });
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
      await applyAnnotation(photoId, message.model, parsed, { content: message.content, usage: message.usage, stop_reason: message.stop_reason, batched: true });
      succeeded++;
    }
    console.log(`[annotation-backfill] batch ${b.anthropicBatchId} ended: ${succeeded} ok, ${errored} failed`);
    await db.annotationBatch.update({ where: { id: b.id }, data: { status: remote.request_counts.canceled ? "CANCELLED" : "ENDED", succeeded, errored, endedAt: new Date() } });
  }
}
