import { db } from "@/lib/db";
import { anthropic } from "@/lib/annotation/client";
import { annotationGates, notOptedOutWhere } from "@/lib/annotation/eligibility";
import { buildPlaceRequest, buildRequest, loadItem } from "@/lib/annotation/request";
import { applyAnnotation, parseMessageContent, recordFailure } from "@/lib/annotation/apply";
import { applyPlaceEstimate, parsePlaceContent, recordPlaceFailure } from "@/lib/annotation/place";
import { enqueue } from "../boss";
import { QUEUES, type AnnotationBackfillJob } from "../queues";
import { permittedNames } from "@/lib/people/gates";
import { NOT_TRASHED } from "@/lib/photos/trash";

export type BackfillWhere = { kind: "all" } | { kind: "trip"; tripId: string } | { kind: "collection"; collectionId: string } | { kind: "range"; from: string; to: string };
/**
 * What a run asks for. "describe" writes the full record for items that have none; "place" asks only where an item
 * was taken, for items with no location. The place pass is deliberately a separate question rather than a second
 * description: most of the items it covers already have descriptions, some of them written by the family.
 */
export type BackfillTask = "describe" | "place" | "names";
export type BackfillScope = BackfillWhere & { task?: BackfillTask };

export function taskOf(scope: BackfillScope): BackfillTask {
  return scope.task === "place" || scope.task === "names" ? scope.task : "describe";
}

/** The names run asks the same question as a description; only which items it asks about is different. */
export function promptFor(task: BackfillTask): "describe" | "place" {
  return task === "place" ? "place" : "describe";
}

/**
 * What a run has left to do: never described, or (for the place pass) no location and never asked about one, or
 * (for the names run) described already — narrowed further by `describedBeforeTheirNames`, which is a comparison
 * between two tables and so cannot be said here.
 */
export function pendingWhere(task: BackfillTask) {
  if (task === "place") return { lat: null, placeEstimatedAt: null };
  if (task === "names") return { annotatedAt: { not: null } };
  return { annotatedAt: null };
}

/**
 * Items described before the album knew who was in them.
 *
 * A description written when nobody was named says "an older couple"; once the family has tagged those two, the
 * album can say their names instead, but only if it is asked again. An item qualifies when somebody nameable is
 * confirmed in it and either the tag or their permission to be named is newer than the description — which makes
 * the run self-clearing, since describing it again moves the description past both.
 *
 * A minor is never named and so never brings an item into this run; a pet always may be.
 */
export async function describedBeforeTheirNames(): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p
    WHERE p."annotatedAt" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Face" f JOIN "Person" pe ON pe.id = f."personId"
      WHERE f."photoId" = p.id AND f.status = 'CONFIRMED' AND pe."optedOutAt" IS NULL
        AND (
          pe.kind = 'PET'
          OR ((pe."faceIndexing" OR pe."nameInDescriptions") AND (pe.birthday IS NULL OR pe.birthday <= (now() - interval '18 years')))
        )
        AND (
          f."createdAt" > p."annotatedAt"
          OR pe."nameInDescriptionsSetAt" > p."annotatedAt"
          OR pe."faceIndexingSetAt" > p."annotatedAt"
        )
    )`;
  return rows.map((r) => r.id);
}

/** Items a backfill would send: in scope, still pending its task, not opted out directly or by inheritance. */
export async function backfillCandidates(scope: BackfillScope) {
  const named = taskOf(scope) === "names" ? { id: { in: await describedBeforeTheirNames() } } : {};
  const base = {
    ...named,
    status: "READY" as const,
    ...NOT_TRASHED,
    ...pendingWhere(taskOf(scope)),
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

/** How many items in scope a backfill leaves out, and why: already done, opted out directly, or by a trip or collection. */
export async function backfillExclusions(scope: BackfillScope): Promise<{ inScope: number; described: number; optedOutSelf: number; optedOutInherited: number }> {
  const scopeWhere =
    scope.kind === "trip" ? { tripId: scope.tripId }
    : scope.kind === "collection" ? { collections: { some: { collectionId: scope.collectionId } } }
    : scope.kind === "range" ? { takenAt: { gte: new Date(`${scope.from}T00:00:00Z`), lte: new Date(`${scope.to}T23:59:59Z`) } }
    : {};
  const ready = { status: "READY" as const, ...NOT_TRASHED, ...scopeWhere };
  const task = taskOf(scope);
  const pending = task === "names" ? { ...pendingWhere(task), id: { in: await describedBeforeTheirNames() } } : pendingWhere(task);
  // "described" is the run's done pile: items already described, or (for the place pass) already placed or asked
  // about, or (for the names run) everything else, since what is left to do is exactly the candidate list.
  const done = task === "place" ? { NOT: pending } : task === "names" ? { NOT: pending } : { annotatedAt: { not: null } };
  const [inScope, described, optedOutSelf, optedOutInherited] = await Promise.all([
    db.photo.count({ where: ready }),
    db.photo.count({ where: { ...ready, ...done } }),
    db.photo.count({ where: { ...ready, ...pending, annotationOptOut: true } }),
    db.photo.count({ where: { ...ready, ...pending, annotationOptOut: false, OR: [{ trip: { annotationOptOut: true } }, { collections: { some: { collection: { annotationOptOut: true } } } }] } }),
  ]);
  return { inScope, described, optedOutSelf, optedOutInherited };
}

/** Items per Message Batch, and the byte budget of image data per batch: well under the API's 256 MB cap, and small enough to upload from a home connection within the request timeout. */
export const BATCH_CHUNK = 200;
export const BATCH_BYTE_BUDGET = 32 * 1024 * 1024;
/** A run with no new row and no start for this long is taken to be dead (a clip-heavy part can spend many minutes between rows). */
export const RUN_IDLE_MS = 60 * 60_000;

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

/**
 * A run must stop when the admin asked on the row they started, when any row of the family was cancelled, or when
 * the poll declared the run over (a loop that was only stalled would otherwise carry on after the "run it again" advice).
 */
export async function familyCancelled(originId: string): Promise<boolean> {
  const row = await db.annotationBatch.findFirst({ where: { OR: [{ id: originId, cancelRequestedAt: { not: null } }, { id: originId, runEndedAt: { not: null } }, { id: originId, status: "CANCELLED" }, { parentId: originId, status: "CANCELLED" }] }, select: { id: true } });
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
  if (!batch) return;
  if (batch.status !== "SUBMITTED" || !batch.anthropicBatchId.startsWith("pending-")) {
    if (batch.parentId || batch.runEndedAt) return;
    // Cancelled before the worker got to it: the run simply never started.
    if (batch.status === "CANCELLED" || batch.cancelRequestedAt) {
      await db.annotationBatch.update({ where: { id: batch.id }, data: { runEndedAt: new Date() } });
      return;
    }
    // A run whose loop is still alive keeps creating rows; only a family idle for a while is a dead one
    // (pg-boss re-delivering after a worker restart), and then the rest was never sent.
    const newest = await db.annotationBatch.findFirst({ where: { OR: [{ id: batch.id }, { parentId: batch.id }] }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const lastSign = Math.max(newest?.createdAt.getTime() ?? 0, batch.startedAt?.getTime() ?? 0);
    if (Date.now() - lastSign < RUN_IDLE_MS) return;
    await db.annotationBatch.update({ where: { id: batch.id }, data: { runEndedAt: new Date(), cancelRequestedAt: new Date() } });
    await db.annotationBatch.create({ data: { anthropicBatchId: `failed-${batch.id}-retry`, parentId: batch.id, scope: batch.scope as object, requested: 0, status: "FAILED", endedAt: new Date(), createdById: batch.createdById } }).catch(() => undefined);
    console.error(`[annotation-backfill] ${batch.id} was cut short (worker restarted); run it again for the remaining items`);
    return;
  }
  // startedAt doubles as the run's last sign of life: it is refreshed before every part and every upload.
  const heartbeat = () => db.annotationBatch.updateMany({ where: { id: batch.id, runEndedAt: null }, data: { startedAt: new Date() } }).catch(() => undefined);
  await heartbeat();
  const task = taskOf(batch.scope as BackfillScope);
  const candidates = await backfillCandidates(batch.scope as BackfillScope);
  let rowId = batch.id;
  let rowLive = false; // whether rowId already carries a real batch id (its results must never be lost)
  let unclaimed: string | null = null; // a batch created at Anthropic whose row claim has not landed yet
  let submittedAny = false;
  let chunkNo = 0;
  const finish = async () => db.annotationBatch.updateMany({ where: { id: batch.id, runEndedAt: null }, data: { runEndedAt: new Date() } }).catch(() => undefined);
  try {
    for (const part of chunk(candidates, BATCH_CHUNK)) {
      if (await familyCancelled(batch.id)) return;
      await heartbeat();
      // Re-check now: an item opted out or described since the run started must not be sent.
      const still = new Set((await db.photo.findMany({ where: { id: { in: part.map((c) => c.id) }, status: "READY", ...NOT_TRASHED, ...pendingWhere(task), kind: notOptedOutWhere.kind, annotationOptOut: false, OR: [...notOptedOutWhere.OR], collections: notOptedOutWhere.collections }, select: { id: true } })).map((p) => p.id));
      const built: { custom_id: string; params: Awaited<ReturnType<typeof buildRequest>>; bytes: number }[] = [];
      const reasons: Record<string, number> = {};
      const skip = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1; };
      for (const c of part) {
        if (!still.has(c.id)) { skip("optedOutOrDescribedMeanwhile"); continue; }
        const item = await loadItem(c.id);
        if (!item) { skip("missing"); continue; }
        try {
          const params = promptFor(task) === "place" ? await buildPlaceRequest(item, gates.model) : await buildRequest(item, gates.model, await permittedNames(item.id));
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
        await heartbeat();
        // A batch upload is large and slow; give it its own timeout and never let the SDK re-upload it on a timeout.
        const created = await anthropic().messages.batches.create({ requests: group.map((g) => ({ custom_id: g.custom_id, params: g.params })) }, { timeout: 10 * 60_000, maxRetries: 0 });
        unclaimed = created.id;
        // The row may have been cancelled while the batch was in flight: then the batch must not run.
        const claimed = await db.annotationBatch.updateMany({ where: { id: rowId, status: "SUBMITTED" }, data: { anthropicBatchId: created.id, requested: group.length, ...skipData } });
        unclaimed = null;
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
    // A batch whose row claim never landed would run untracked: stop it rather than pay for results nobody applies.
    if (unclaimed) await anthropic().messages.batches.cancel(unclaimed).catch(() => {});
    // Fail only a placeholder row; a live row keeps polling so its billed results are still applied.
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
    const failedInPlace = rowLive ? 0 : (await db.annotationBatch.updateMany({ where: { id: rowId, anthropicBatchId: { startsWith: "pending-" } }, data: { status: "FAILED", endedAt: new Date(), anthropicBatchId: `failed-${batch.id}-${chunkNo}` } }).catch(() => ({ count: 0 }))).count;
    // A live row, or one already closed as empty, keeps its state; a marker row records that the rest was not sent.
    if (failedInPlace === 0) await db.annotationBatch.create({ data: { anthropicBatchId: `failed-${batch.id}-${chunkNo}`, parentId: batch.id, scope: batch.scope as object, requested: 0, status: "FAILED", endedAt: new Date(), createdById: batch.createdById } }).catch(() => undefined);
    console.error(`[annotation-backfill] ${rowId} failed: ${message}`);
    return;
  } finally {
    await finish();
  }
  // First poll soon after submission; the five-minute schedule takes over from there.
  if (submittedAny) await enqueue(QUEUES.annotationBatchPoll, {}, { startAfter: 5, singletonKey: "annotation-batch-poll", singletonSeconds: 5 });
}

/**
 * A run whose worker died between chunks leaves no placeholder to sweep: its origin was started long ago, nothing
 * in its family has been created since, and no cancel was asked. Close it and leave the "run it again" marker.
 */
export async function closeDeadRuns(cutoff: Date): Promise<number> {
  const candidates = await db.annotationBatch.findMany({ where: { parentId: null, runEndedAt: null, cancelRequestedAt: null, startedAt: { lt: cutoff } }, select: { id: true, scope: true, createdById: true } });
  // startedAt is refreshed as a heartbeat while the loop runs, so an old value means no sign of life since.
  let closed = 0;
  for (const origin of candidates) {
    const recent = await db.annotationBatch.findFirst({ where: { OR: [{ id: origin.id }, { parentId: origin.id }], createdAt: { gte: cutoff } }, select: { id: true } });
    if (recent) continue;
    const pendingChild = await db.annotationBatch.findFirst({ where: { parentId: origin.id, status: "SUBMITTED", anthropicBatchId: { startsWith: "pending-" } }, select: { id: true } });
    if (pendingChild) continue; // the stale sweep closes that one
    // Both marks: runEndedAt closes the run for the admin page, cancelRequestedAt stops a loop that was merely stalled.
    await db.annotationBatch.update({ where: { id: origin.id }, data: { runEndedAt: new Date(), cancelRequestedAt: new Date() } });
    await db.annotationBatch.create({ data: { anthropicBatchId: `failed-${origin.id}-retry`, parentId: origin.id, scope: origin.scope as object, requested: 0, status: "FAILED", endedAt: new Date(), createdById: origin.createdById } }).catch(() => undefined);
    console.error(`[annotation-backfill] ${origin.id} was cut short (worker restarted); run it again for the remaining items`);
    closed += 1;
  }
  return closed;
}

/** Poll open batches; apply each result, validating by hand since `parse` does not apply to batch results. */
export async function annotationBatchPoll(): Promise<void> {
  // A placeholder whose run started over an hour ago belongs to a worker that died mid-loop; nothing will submit it now.
  // (A run that merely waited in the queue has no startedAt and is left alone for a day.)
  const hourAgo = new Date(Date.now() - 3_600_000);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const stale = await db.annotationBatch.findMany({ where: { status: "SUBMITTED", anthropicBatchId: { startsWith: "pending-" }, OR: [{ startedAt: { lt: hourAgo } }, { parentId: { not: null }, createdAt: { lt: hourAgo } }, { startedAt: null, createdAt: { lt: dayAgo } }] }, select: { id: true, parentId: true } });
  if (stale.length) {
    await db.annotationBatch.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { status: "FAILED", endedAt: new Date(), runEndedAt: new Date() } });
    // The run those placeholders belonged to is over as well.
    const origins = [...new Set(stale.map((r) => r.parentId).filter(Boolean) as string[])];
    if (origins.length) await db.annotationBatch.updateMany({ where: { id: { in: origins }, runEndedAt: null }, data: { runEndedAt: new Date() } });
    console.error(`[annotation-backfill] placeholders never submitted (worker died mid-run): ${stale.map((r) => r.id).join(", ")}; run the backfill again for the remaining items`);
  }
  await closeDeadRuns(hourAgo);
  // Cancelled rows with a live batch id still get their (already billed) results applied once the batch ends.
  const open = (await db.annotationBatch.findMany({ where: { OR: [{ status: "SUBMITTED" }, { status: "CANCELLED", endedAt: null }] } })).filter((b) => !b.anthropicBatchId.startsWith("pending-") && !b.anthropicBatchId.startsWith("empty-"));
  for (const b of open) {
    // A place-pass row has nothing to say about descriptions, so its results are read the other way round.
    const task = taskOf(b.scope as BackfillScope);
    const remote = await anthropic().messages.batches.retrieve(b.anthropicBatchId).catch(() => null);
    if (!remote) continue;
    if (remote.processing_status !== "ended") continue;
    let succeeded = 0, errored = 0, canceled = 0;
    for await (const result of await anthropic().messages.batches.results(b.anthropicBatchId)) {
      const photoId = result.custom_id;
      // A place run never writes annotation state: an item it could not place keeps whatever description it has.
      const fail = (reason: string, opts?: { terminal?: boolean }) => (promptFor(task) === "place" ? recordPlaceFailure(photoId, opts ?? {}) : recordFailure(photoId, reason, opts ?? {}));
      if (result.result.type !== "succeeded") {
        // Errored, expired or cancelled: the helper never saw the item, so leave it eligible for a later backfill.
        if (result.result.type === "canceled") canceled++;
        else errored++;
        await fail(`batch:${result.result.type}`, { terminal: false });
        continue;
      }
      const message = result.result.message;
      if (message.stop_reason === "refusal") {
        errored++;
        await fail(`refusal:${message.stop_details?.category ?? "unspecified"}`);
        continue;
      }
      if (message.stop_reason === "max_tokens") {
        errored++;
        await fail("max_tokens");
        continue;
      }
      if (promptFor(task) === "place") {
        const place = parsePlaceContent(message.content as { type: string; text?: string }[]);
        if (place === undefined) {
          errored++;
          await fail("invalid_output");
          continue;
        }
        await applyPlaceEstimate(photoId, place);
        succeeded++;
        continue;
      }
      const parsed = parseMessageContent(message.content as { type: string; text?: string }[]);
      if (!parsed) {
        errored++;
        await fail("invalid_output");
        continue;
      }
      await applyAnnotation(photoId, message.model, parsed, { content: message.content, usage: message.usage, stop_reason: message.stop_reason, batched: true });
      succeeded++;
    }
    console.log(`[annotation-backfill] batch ${b.anthropicBatchId} ended: ${succeeded} ok, ${errored} failed, ${canceled} cancelled`);
    await db.annotationBatch.update({ where: { id: b.id }, data: { status: b.status === "CANCELLED" || remote.request_counts.canceled ? "CANCELLED" : "ENDED", succeeded, errored, canceled, endedAt: new Date() } });
  }
}
