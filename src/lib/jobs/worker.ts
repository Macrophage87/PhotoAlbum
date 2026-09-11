import { db } from "@/lib/db";
import { getBoss, JOB_EXPIRE_SECONDS } from "./boss";
import { QUEUES } from "./queues";

/**
 * A photo left in PROCESSING longer than the job expiry plus all retries can no longer have a live job
 * (the process that owned it died). Mark it FAILED so the uploader stops spinning and "Re-process" is offered.
 * PENDING rows are left alone: they may simply be queued behind a long backlog.
 */
export async function reconcileStalePhotos(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - JOB_EXPIRE_SECONDS * 4 * 1000);
  const res = await db.photo.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    data: { status: "FAILED", error: "Processing was interrupted by a restart. Use Re-process to try again." },
  });
  if (res.count) console.warn(`[worker] marked ${res.count} stale photo(s) as FAILED`);
  return res.count;
}

/** Registers every handler. Handlers are imported lazily so the web bundle stays light. */
export async function startWorker(): Promise<void> {
  const boss = await getBoss();

  const { processPhoto } = await import("./handlers/process-photo");
  const { importTrack } = await import("./handlers/import-track");
  const { geotagPhotos } = await import("./handlers/geotag-photos");
  const { deletePhoto } = await import("./handlers/delete-photo");
  const { checkExternalVideos } = await import("./handlers/check-external-videos");

  await boss.work(QUEUES.processPhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) =>
    processPhoto(job.data as never),
  );
  await boss.work(QUEUES.importTrack, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) =>
    importTrack(job.data as never),
  );
  await boss.work(QUEUES.geotagPhotos, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) =>
    geotagPhotos(job.data as never),
  );
  await boss.work(QUEUES.deletePhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 5 }, async ([job]) =>
    deletePhoto(job.data as never),
  );
  await boss.work(QUEUES.checkExternalVideos, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => checkExternalVideos());
  // Weekly re-check of embedded videos (Monday 04:00 UTC); schedule() is idempotent.
  await boss.schedule(QUEUES.checkExternalVideos, "0 4 * * 1", {}, { retryLimit: 1 });
  console.log("[worker] pg-boss handlers registered");
  await reconcileStalePhotos().catch((err) => console.error("[worker] stale-photo reconciliation failed", err));
}
