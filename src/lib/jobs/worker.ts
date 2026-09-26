import { db } from "@/lib/db";
import { getBoss, HEAVY_HEARTBEAT_REFRESH_SECONDS, HEAVY_JOB_EXPIRE_SECONDS, JOB_EXPIRE_SECONDS } from "./boss";
import { QUEUES } from "./queues";

/**
 * A photo left in PROCESSING longer than the job expiry plus all retries can no longer have a live job
 * (the process that owned it died). Mark it FAILED so the uploader stops spinning and "Re-process" is offered.
 * PENDING rows are left alone: they may simply be queued behind a long backlog. Runs at startup and every quarter
 * hour, since a worker that keeps crashing on one item restarts too soon for the startup pass to see it.
 */
export async function reconcileStalePhotos(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - JOB_EXPIRE_SECONDS * 4 * 1000);
  // Clips are transcoded on a heavy queue, whose jobs may run (and wait for the lock) for longer.
  const clipCutoff = new Date(now.getTime() - HEAVY_JOB_EXPIRE_SECONDS * 4 * 1000);
  const res = await db.photo.updateMany({
    where: { status: "PROCESSING", OR: [{ kind: { not: "VIDEO" }, updatedAt: { lt: cutoff } }, { kind: "VIDEO", updatedAt: { lt: clipCutoff } }] },
    data: { status: "FAILED", error: "Processing was interrupted by a restart. Use Re-process to try again." },
  });
  if (res.count) console.warn(`[worker] marked ${res.count} stale photo(s) as FAILED`);
  return res.count;
}

/** Registers every handler. Handlers are imported lazily so the web bundle stays light. */
export async function startWorker(): Promise<void> {
  const boss = await getBoss();

  // First, before anything else starts: the members-only sweep. After a deploy that changed the matcher, text naming
  // somebody that is not tagged stays public until it has run; after that it judges only names the album has learned
  // since, and again every night, so a change whose job could not be queued is judged within a day.
  const { rejudgeText, enqueueRejudge } = await import("@/lib/annotation/rejudge");
  await boss.work(QUEUES.rejudgeText, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    const r = await rejudgeText(job.data as never);
    console.log(`[rejudge] ${r.photos} photo(s), ${r.titles} title(s) and ${r.descriptions} description(s) kept for members, ${r.unflagged} shown again, ${r.places} place guess(es)`);
  });

  await boss.schedule(QUEUES.rejudgeText, "20 3 * * *", { sweep: true }, { retryLimit: 1 });
  await enqueueRejudge({ sweep: true }).catch((err) => console.error("[worker] could not queue the members-only sweep", err));

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
  const { purgeVisits } = await import("@/lib/visits/record");
  const { purgeExpiredMagicLinks } = await import("@/lib/auth/magic-link");
  const { sweepStrandedUploads } = await import("@/lib/media/stranded");

  await boss.work(QUEUES.processPhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) =>
    processPhoto(job.data as never, job.signal),
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
  await boss.work(QUEUES.transcodeVideo, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: HEAVY_HEARTBEAT_REFRESH_SECONDS }, async ([job]) => transcodeVideo(job.data as never, job.signal));
  await boss.work(QUEUES.checkExternalVideos, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => checkExternalVideos());
  await boss.work(QUEUES.annotatePhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 3 }, async ([job]) => annotatePhoto(job.data as never));
  await boss.work(QUEUES.annotationSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await annotationSweep()));
  await boss.work(QUEUES.annotationBackfill, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => annotationBackfill(job.data as never));
  await boss.work(QUEUES.annotationBatchPoll, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => annotationBatchPoll());
  // Sidecar calls: one at a time and under the heavy lock, so they never overlap a transcode. The heavy handlers take
  // the job's signal, which pg-boss fires when it times a job out, so a late run stops instead of racing its retry.
  await boss.work(QUEUES.embedPhoto, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3, heartbeatRefreshSeconds: HEAVY_HEARTBEAT_REFRESH_SECONDS }, async ([job]) => embedPhoto(job.data as never, job.signal));
  await boss.work(QUEUES.embedSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await embedSweep()));
  await boss.work(QUEUES.detectFaces, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3, heartbeatRefreshSeconds: HEAVY_HEARTBEAT_REFRESH_SECONDS }, async ([job]) => detectFacesJob(job.data as never, job.signal));
  await boss.work(QUEUES.takeoutImport, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => importTakeoutArchive((job.data as { importId: string }).importId));
  await boss.work(QUEUES.detectAnimals, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3, heartbeatRefreshSeconds: HEAVY_HEARTBEAT_REFRESH_SECONDS }, async ([job]) => detectAnimalsJob(job.data as never, job.signal));
  await boss.work(QUEUES.animalSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await animalSweep()));
  await boss.work(QUEUES.matchAnimals, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => void (await proposeAnimalsForPhoto((job.data as { photoId: string }).photoId)));
  await boss.work(QUEUES.googlePickerImport, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2, includeMetadata: true }, async ([job]) =>
    googlePickerImport(job.data as never, job.signal, { finalAttempt: job.retryCount >= job.retryLimit }),
  );
  await boss.work(QUEUES.matchPhoto, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => matchPhoto(job.data as never));
  await boss.work(QUEUES.faceSweep, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 }, async () => void (await faceSweep()));
  // The nightly people job also takes out of the helper's text the names of people whose naming the album switched
  // off by itself, once admins have had their fortnight to keep them (see Person.namingWithdrawnAt).
  const { scrubWithdrawnNames } = await import("@/lib/people/forget");
  // And forgets asked for while FORGET_KEY was missing, once it is set.
  const { completePendingForgets } = await import("@/lib/people/forget-person");
  await boss.work(QUEUES.flagNewAdults, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => {
    await flagNewAdults();
    await scrubWithdrawnNames();
    await completePendingForgets();
  });
  await boss.work(QUEUES.purgeUnnamedFaces, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeUnnamedFaces()));
  await boss.work(QUEUES.purgeAnnotationRaw, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeAnnotationRaw()));
  await boss.work(QUEUES.purgeVisits, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeVisits()));
  await boss.work(QUEUES.purgeMagicLinks, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await purgeExpiredMagicLinks({ db })));
  await boss.work(QUEUES.sweepStrandedUploads, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await sweepStrandedUploads()));
  await boss.work(QUEUES.reconcilePhotos, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 60 }, async () => void (await reconcileStalePhotos()));
  // Schedules (idempotent): weekly video re-check, the annotation quiet-period sweep, batch polling, raw-response purge,
  // and the stale-photo reconciliation.
  await boss.schedule(QUEUES.checkExternalVideos, "0 4 * * 1", {}, { retryLimit: 1 });
  await boss.schedule(QUEUES.annotationSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.annotationBatchPoll, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.purgeAnnotationRaw, "30 3 * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.embedSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.faceSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.animalSweep, "*/5 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.purgeUnnamedFaces, "45 3 * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.flagNewAdults, "50 3 * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.purgeVisits, "15 3 * * *", {}, { retryLimit: 0 });
  // Expired sign-in links, including placeholders for addresses that may not sign in.
  await boss.schedule(QUEUES.purgeMagicLinks, "20 3 * * *", {}, { retryLimit: 0 });
  // A naming the album withdrew by itself: what strangers can read loses the name at once, not at the next night.
  await scrubWithdrawnNames().catch((err) => console.error("[worker] withdrawn-name scrub failed", err));
  await completePendingForgets().catch((err) => console.error("[worker] pending forgets failed", err));
  await boss.schedule(QUEUES.sweepStrandedUploads, "40 * * * *", {}, { retryLimit: 0 });
  await boss.schedule(QUEUES.reconcilePhotos, "*/15 * * * *", {}, { retryLimit: 0 });
  console.log("[worker] pg-boss handlers registered");
  // Before the reconciliation below, so a Picker download lost in the restart is told to be picked again rather
  // than re-processed (it has no file to process).
  await (await import("@/lib/media/stranded")).sweepStrandedUploads().catch((err) => console.error("[worker] stranded-upload sweep failed", err));
  await reconcileStalePhotos().catch((err) => console.error("[worker] stale-photo reconciliation failed", err));
  await (await import("@/lib/tracks/files")).forgetGoogleExports().catch((err) => console.error("[worker] could not delete old Google exports", err));
}
