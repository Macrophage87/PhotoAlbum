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
  const { transcodeVideo } = await import("./handlers/transcode-video");
  const { annotatePhoto } = await import("./handlers/annotate-photo");
  const { annotationSweep, purgeAnnotationRaw } = await import("./handlers/annotation-sweep");
  const { annotationBackfill, annotationBatchPoll } = await import("./handlers/annotation-batch");
  const { embedPhoto, embedSweep } = await import("./handlers/embed-photo");
  const { detectFacesJob, faceSweep, purgeUnnamedFaces, flagNewAdults } = await import("./handlers/detect-faces");
  const { matchPhoto } = await import("./handlers/match-photo");
  const { importTakeoutArchive } = await import("@/lib/takeout/import");
  const { googlePickerImport } = await import("./handlers/google-picker-import");
  const { detectAnimalsJob, animalSweep } = await import("./handlers/detect-animals");
  const { proposeAnimalsForPhoto } = await import("@/lib/pets/proposals");

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
  // One clip at a time; the handler also takes the heavy-work lock so it never overlaps other heavy jobs.
  await boss.work(QUEUES.transcodeVideo, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) => transcodeVideo(job.data as never));
  await boss.work(QUEUES.checkExternalVideos, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => checkExternalVideos());
  await boss.work(QUEUES.annotatePhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 3 }, async ([job]) => annotatePhoto(job.data as never));
  await boss.work(QUEUES.annotationSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await annotationSweep()));
  await boss.work(QUEUES.annotationBackfill, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => annotationBackfill(job.data as never));
  await boss.work(QUEUES.annotationBatchPoll, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => annotationBatchPoll());
  // Sidecar calls: one at a time and under the heavy lock, so they never overlap a transcode.
  await boss.work(QUEUES.embedPhoto, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async ([job]) => embedPhoto(job.data as never));
  await boss.work(QUEUES.embedSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await embedSweep()));
  await boss.work(QUEUES.detectFaces, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async ([job]) => detectFacesJob(job.data as never));
  await boss.work(QUEUES.takeoutImport, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => importTakeoutArchive((job.data as { importId: string }).importId));
  await boss.work(QUEUES.detectAnimals, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async ([job]) => detectAnimalsJob(job.data as never));
  await boss.work(QUEUES.animalSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await animalSweep()));
  await boss.work(QUEUES.matchAnimals, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => void (await proposeAnimalsForPhoto((job.data as { photoId: string }).photoId)));
  await boss.work(QUEUES.googlePickerImport, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) => googlePickerImport(job.data as never));
  await boss.work(QUEUES.matchPhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => matchPhoto(job.data as never));
  await boss.work(QUEUES.faceSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await faceSweep()));
  await boss.work(QUEUES.flagNewAdults, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await flagNewAdults()));
  await boss.work(QUEUES.purgeUnnamedFaces, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeUnnamedFaces()));
  await boss.work(QUEUES.purgeAnnotationRaw, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeAnnotationRaw()));
  // Schedules (idempotent): weekly video re-check, the annotation quiet-period sweep, batch polling, raw-response purge.
  await boss.schedule(QUEUES.checkExternalVideos, "0 4 * * 1", {}, { retryLimit: 1 });
  await boss.schedule(QUEUES.annotationSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.annotationBatchPoll, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.purgeAnnotationRaw, "30 3 * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.embedSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.faceSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.animalSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.purgeUnnamedFaces, "45 3 * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.flagNewAdults, "50 3 * * *", {}, { retryLimit: 0 });
  console.log("[worker] pg-boss handlers registered");
  await reconcileStalePhotos().catch((err) => console.error("[worker] stale-photo reconciliation failed", err));
}
