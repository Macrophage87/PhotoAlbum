import { db } from "@/lib/db";
import { anthropic } from "@/lib/annotation/client";
import { annotationGates, notOptedOutWhere } from "@/lib/annotation/eligibility";
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
  return db.photo.findMany({ where, select: { id: true, kind: true }, orderBy: { createdAt: "asc" }, take: BACKFILL_CAP });
}

/** One run sends at most this many items; the preview says so when a scope is larger. */
export const BACKFILL_CAP = 10_000;

/** How many items in scope a backfill leaves out, and why: already described, opted out directly, or by a trip or collection. */
export async function backfillExclusions(scope: BackfillScope): Promise<{ inScope: number; described: number; optedOutSelf: number; optedOutInherited: number }> {
  const scopeWhere =
    scope.kind === "trip" ? { tripId: scope.tripId }
    : scope.kind === "collection" ? { collections: { some: { collectionId: scope.collectionId } } }
    : scope.kind === "range" ? { takenAt: { gte: new Date(`${scope.from}T00:00:00Z`), lte: new Date(`${scope.to}T23:59:59Z`) } }
    : {};
  const ready = { status: "READY" as const, ...scopeWhere };
  const [inScope, described, optedOutSelf, optedOutInherited] = await Promise.all([
    db.photo.count({ where: ready }),
    db.photo.count({ where: { ...ready, annotatedAt: { not: null } } }),
    db.photo.count({ where: { ...ready, annotatedAt: null, annotationOptOut: true } }),
    db.photo.count({ where: { ...ready, annotatedAt: null, annotationOptOut: false, OR: [{ trip: { annotationOptOut: true } }, { collections: { some: { collection: { annotationOptOut: true } } } }] } }),
  ]);
  return { inScope, described, optedOutSelf, optedOutInherited };
}

/** Items per Message Batch, and the byte budget of image data per batch: well under the API's 256 MB cap, and small enough to upload from a home connection within the request timeout. */
export const BATCH_CHUNK = 200;
export const BATCH_BYTE_BUDGET = 32 * 1024 * 1024;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Split built requests so no batch carries more than the byte budget of base64 image data. Pure. */
export function splitByBytes<T extends { bytes: number }>(items: T[], budget: number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const it of items) {
    if (current.length && used + it.bytes > budget) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(it);
    used += it.bytes;
  }
  if (current.length) out.push(current);
  return out;
}

function imageBytes(params: Awaited<ReturnType<typeof buildRequest>>): number {
  let n = 0;
  for (const m of params.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "image" && b.source.type === "base64") n += b.source.data.length;
  return n;
}

/** A run is cancelled when the admin asked on the row they started, or when any row of the family was cancelled. */
export async function familyCancelled(originId: string): Promise<boolean> {
  const row = await db.annotationBatch.findFirst({ where: { OR: [{ id: originId, cancelRequestedAt: { not: null } }, { id: originId, status: "CANCELLED" }, { parentId: originId, status: "CANCELLED" }] }, select: { id: true } });
  return Boolean(row);
}

/**
 * Submit the scope as a series of Message Batches: at most BATCH_CHUNK items and BATCH_BYTE_BUDGET of image data
 * each, built just before they are sent. Every chunk's ids are re-checked against opt-outs and prior annotation at
 * that moment. The first chunk reuses the placeholder row; later chunks get rows pointing at it, and a cancel on
 * any row of the family stops the run (a batch created after a cancel raced it is cancelled remotely). Results are
 * collected by the poll job.
 */
export async function annotationBackfill(job: AnnotationBackfillJob): Promise<void> {
  const gates = await annotationGates();
  if (!gates.active) return;
  const batch = await db.annotationBatch.findUnique({ where: { id: job.batchId } });
  if (!batch || batch.status !== "SUBMITTED" || !batch.anthropicBatchId.startsWith("pending-")) return;
  await db.annotationBatch.update({ where: { id: batch.id }, data: { startedAt: new Date() } });
  const candidates = await backfillCandidates(batch.scope as BackfillScope);
  let rowId = batch.id;
  let rowLive = false; // whether rowId already carries a real batch id (its results must never be lost)
  let submittedAny = false;
  let chunkNo = 0;
  const finish = async () => db.annotationBatch.update({ where: { id: batch.id }, data: { runEndedAt: new Date() } }).catch(() => undefined);
  try {
    for (const part of chunk(candidates, BATCH_CHUNK)) {
      if (await familyCancelled(batch.id)) return;
      // Re-check now: an item opted out or described since the run started must not be sent.
      const still = new Set((await db.photo.findMany({ where: { id: { in: part.map((c) => c.id) }, status: "READY", annotatedAt: null, annotationOptOut: false, OR: [...notOptedOutWhere.OR], collections: notOptedOutWhere.collections }, select: { id: true } })).map((p) => p.id));
      const built: { custom_id: string; params: Awaited<ReturnType<typeof buildRequest>>; bytes: number }[] = [];
      const reasons: Record<string, number> = {};
      const skip = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1; };
      for (const c of part) {
        if (!still.has(c.id)) { skip("optedOutOrDescribedMeanwhile"); continue; }
        const item = await loadItem(c.id);
        if (!item) { skip("missing"); continue; }
        try {
          const params = await buildRequest(item, gates.model, await permittedNames(item.id));
          built.push({ custom_id: c.id, params, bytes: imageBytes(params) });
        } catch {
          skip("noRendition");
        }
      }
      const skipped = Object.values(reasons).reduce((a, b) => a + b, 0);
      const groups = built.length ? splitByBytes(built, BATCH_BYTE_BUDGET) : [[]];
      for (const [gi, group] of groups.entries()) {
        if (await familyCancelled(batch.id)) return;
        // Skips belong to the part, so only its first row carries them.
        const skipData = gi === 0 ? { skipped, skippedReasons: reasons } : {};
        if (chunkNo > 0) {
          rowId = (await db.annotationBatch.create({ data: { anthropicBatchId: `pending-${batch.id}-${chunkNo}`, parentId: batch.id, scope: batch.scope as object, requested: 0, createdById: batch.createdById }, select: { id: true } })).id;
          rowLive = false;
        }
        chunkNo += 1;
        if (!group.length) {
          await db.annotationBatch.update({ where: { id: rowId }, data: { status: "ENDED", ...skipData, endedAt: new Date(), anthropicBatchId: `empty-${rowId}` } });
          continue;
        }
        // A batch upload is large and slow; give it its own timeout and never let the SDK re-upload it on a timeout.
        const created = await anthropic().messages.batches.create({ requests: group.map((g) => ({ custom_id: g.custom_id, params: g.params })) }, { timeout: 10 * 60_000, maxRetries: 0 });
        // The row may have been cancelled while the batch was in flight: then the batch must not run.
        const claimed = await db.annotationBatch.updateMany({ where: { id: rowId, status: "SUBMITTED" }, data: { anthropicBatchId: created.id, requested: group.length, ...skipData } });
        if (claimed.count === 0) {
          await anthropic().messages.batches.cancel(created.id).catch(() => {});
          console.log(`[annotation-backfill] batch ${created.id} cancelled: its row was cancelled during submission`);
          return;
        }
        rowLive = true;
        submittedAny = true;
        // A cancel that landed between the last check and the claim: stop the batch, keep the row for its results.
        if (await familyCancelled(batch.id)) {
          await anthropic().messages.batches.cancel(created.id).catch(() => {});
          await db.annotationBatch.updateMany({ where: { id: rowId, status: "SUBMITTED" }, data: { status: "CANCELLED", endedAt: null } });
          console.log(`[annotation-backfill] batch ${created.id} cancelled right after submission`);
          return;
        }
        console.log(`[annotation-backfill] batch ${created.id} submitted with ${group.length} requests (${skipped} skipped), chunk ${chunkNo}`);
      }
    }
  } catch (err) {
    // Fail only a placeholder row; a live row keeps polling so its billed results are still applied.
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
    if (rowLive) await db.annotationBatch.create({ data: { anthropicBatchId: `failed-${batch.id}-${chunkNo}`, parentId: batch.id, scope: batch.scope as object, requested: 0, status: "FAILED", endedAt: new Date(), createdById: batch.createdById } }).catch(() => undefined);
    else await db.annotationBatch.updateMany({ where: { id: rowId, anthropicBatchId: { startsWith: "pending-" } }, data: { status: "FAILED", endedAt: new Date() } }).catch(() => undefined);
    console.error(`[annotation-backfill] ${rowId} failed: ${message}`);
    return;
  } finally {
    await finish();
  }
  // First poll soon after submission; the five-minute schedule takes over from there.
  if (submittedAny) await enqueue(QUEUES.annotationBatchPoll, {}, { startAfter: 5, singletonKey: "annotation-batch-poll", singletonSeconds: 5 });
}

/** Poll open batches; apply each result, validating by hand since `parse` does not apply to batch results. */
export async function annotationBatchPoll(): Promise<void> {
  // A placeholder whose run started over an hour ago belongs to a worker that died mid-loop; nothing will submit it now.
  // (A run that merely waited in the queue has no startedAt and is left alone for a day.)
  const hourAgo = new Date(Date.now() - 3_600_000);
  const dayAgo = new Date(Date.now() - 86_400_000);
  await db.annotationBatch.updateMany({ where: { status: "SUBMITTED", anthropicBatchId: { startsWith: "pending-" }, OR: [{ startedAt: { lt: hourAgo } }, { parentId: { not: null }, createdAt: { lt: hourAgo } }, { startedAt: null, createdAt: { lt: dayAgo } }] }, data: { status: "FAILED", endedAt: new Date(), runEndedAt: new Date() } });
  // Cancelled rows with a live batch id still get their (already billed) results applied once the batch ends.
  const open = (await db.annotationBatch.findMany({ where: { OR: [{ status: "SUBMITTED" }, { status: "CANCELLED", endedAt: null }] } })).filter((b) => !b.anthropicBatchId.startsWith("pending-") && !b.anthropicBatchId.startsWith("empty-"));
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
      if (message.stop_reason === "max_tokens") {
        errored++;
        await recordFailure(photoId, "max_tokens");
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
    await db.annotationBatch.update({ where: { id: b.id }, data: { status: b.status === "CANCELLED" || remote.request_counts.canceled ? "CANCELLED" : "ENDED", succeeded, errored, endedAt: new Date() } });
  }
}
