import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { sha256File } from "@/lib/media/hash";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";
import { ffmpeg, posterArgs, probe, transcodeArgs } from "@/lib/video/ffmpeg";
import { pickTripByDay, whoWasThere } from "@/lib/photos/assign";
import { activityFor } from "@/lib/activities/reassign";
import { dateByHand, dateMovedSince, lockedPhoto } from "@/lib/photos/member-owned";
import { localDayFromOffset, offsetMinutesInZone } from "@/lib/time/local-day";
import { withHeavyLock } from "../heavy-lock";
import { workerStopping } from "../shutdown";
import type { TranscodeVideoJob } from "../queues";
import { enqueueEmbedding } from "./embed-photo";
import { enqueueFaceDetection } from "./detect-faces";
import { enqueueAnimalDetection } from "./detect-animals";

export type VideoRenditions = { mp4: { key: string; w: number; h: number; bytes: number }; poster: { key: string } };

export function tooLongMessage(durationS: number, limit: number): string {
  return `This video is ${Math.round(durationS)} seconds long; clips uploaded here are limited to ${limit} seconds. Upload longer videos to YouTube as Unlisted and add the link instead.`;
}

/**
 * Turn an uploaded clip into a web-playable MP4 with a poster and thumbnails. The duration limit is enforced here
 * as the authority, even though the browser checks first. Runs under the heavy-work lock. `signal` is pg-boss's,
 * fired when the job times out: ffmpeg is killed and nothing more is written, so the retry never overlaps it.
 */
export async function transcodeVideo(job: TranscodeVideoJob, signal?: AbortSignal): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId } });
  if (!photo) return;
  const store = storage();
  let work: string | null = null;
  // The stamp marks the row as this run's: a retry of a timed-out run stamps it again.
  let claimedAt: Date | null = null;
  // Everything after the row turns PROCESSING is inside the try, so no failure can leave it spinning.
  try {
    claimedAt = (await db.photo.update({ where: { id: photo.id }, data: { status: "PROCESSING", error: null }, select: { updatedAt: true } })).updatedAt;
    const input = store.localPath?.(photo.originalPath);
    if (!input) throw new Error("transcode-video requires a storage driver with local paths");
    const dir = (work = await mkdtemp(path.join(tmpdir(), "clip-")));
    await withHeavyLock(async () => {
      const info = await probe(input, signal);
      const limit = env().MAX_CLIP_SECONDS;
      // A clip already accepted is not refused on a Re-process because the limit has since been lowered.
      if (!photo.videoRenditions && info.durationS !== null && info.durationS > limit) throw new Error(tooLongMessage(info.durationS, limit));

      const mp4 = path.join(dir, "video.mp4");
      const poster = path.join(dir, "poster.jpg");
      await ffmpeg(transcodeArgs(input, mp4, info), signal);
      await ffmpeg(posterArgs(mp4, poster, info.durationS), signal);
      const out = await probe(mp4, signal);
      signal?.throwIfAborted();
      const mp4Key = `${photo.storageKey}/video.mp4`;
      const posterKey = `${photo.storageKey}/poster.jpg`;
      await store.putBuffer(mp4Key, await readFile(mp4));
      await store.putBuffer(posterKey, await readFile(poster));
      const { renditions } = await makeRenditions(poster, photo.storageKey, (key, buf) => store.putBuffer(key, buf));
      const bytes = (await stat(mp4)).size;

      // Dates: one a member set by hand wins, then a Takeout sidecar's (Google's own record of when it was filmed),
      // then the container's creation time, then the file's modified time sent by the browser, then upload time.
      const mtimeHeader = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified;
      const byHand = photo.takenAtSource === "MANUAL" && photo.takenAt ? photo.takenAt : null;
      const fromSidecar = photo.takenAtSource === "SIDECAR" && photo.takenAt ? photo.takenAt : null;
      let instant = byHand ?? fromSidecar ?? info.createdAt ?? (mtimeHeader && Number.isFinite(mtimeHeader) ? new Date(mtimeHeader) : photo.createdAt);
      let takenAtSource: "MANUAL" | "SIDECAR" | "EXIF_OFFSET" | "FILE_MTIME" | "UPLOAD_TIME" = byHand ? "MANUAL" : fromSidecar ? "SIDECAR" : info.createdAt ? "EXIF_OFFSET" : mtimeHeader ? "FILE_MTIME" : "UPLOAD_TIME";
      if (Number.isNaN(instant.getTime())) {
        instant = photo.createdAt;
        takenAtSource = "UPLOAD_TIME";
      }
      let trip = job.tripId ? await db.trip.findUnique({ where: { id: job.tripId } }) : photo.tripId ? await db.trip.findUnique({ where: { id: photo.tripId } }) : null;
      if (!trip) {
        const candidates = await db.trip.findMany({ where: whoWasThere(photo.uploaderId), select: { id: true, startDate: true, endDate: true, timezone: true } });
        const matches = candidates.filter((c) => pickTripByDay([c], localDayFromOffset(instant, offsetMinutesInZone(instant, c.timezone))));
        if (matches.length === 1) trip = await db.trip.findUnique({ where: { id: matches[0].id } });
      }
      // A hand-set date keeps the zone it was typed in.
      const tzOffsetMin = byHand && photo.tzOffsetMin !== null ? photo.tzOffsetMin : trip ? offsetMinutesInZone(instant, trip.timezone) : 0;
      const videoRenditions: VideoRenditions = { mp4: { key: mp4Key, w: out.width ?? 0, h: out.height ?? 0, bytes }, poster: { key: posterKey } };
      const contentHash = photo.contentHash ?? (await sha256File(input));
      // The row was read before the heavy lock and ffmpeg, minutes ago: a member may have dated the clip or filed it
      // on an activity since. So it is read again, locked, and what a member set is never written over.
      await db.$transaction(async (tx) => {
        const now = await lockedPhoto(tx, photo.id);
        if (!now) return;
        // A date given (or changed) since the job read the row stands, and so does the trip it put the clip on; a
        // date a member set before is kept as it is too (its trip still follows from it, as the job read it).
        const moved = dateMovedSince(photo, now);
        const keepDate = moved || dateByHand(now);
        const tripId = moved || now.tripId !== photo.tripId ? now.tripId : (trip?.id ?? null);
        // A clip uploaded into an activity, or filed (or taken off one) by hand, stays where the member put it.
        const filing = await activityFor(now, tripId, keepDate ? now.takenAt : instant, tx);
        await tx.photo.update({
          where: { id: photo.id },
          data: {
            status: "READY",
            contentHash,
            kind: "VIDEO",
            width: out.width,
            height: out.height,
            durationS: out.durationS ?? info.durationS,
            renditions,
            videoRenditions,
            ...(keepDate ? {} : { takenAt: instant, takenAtSource, tzOffsetMin }),
            tripId,
            activityId: filing.activityId,
            activitySetById: filing.activitySetById,
            camera: info.videoCodec ? `${info.videoCodec}${info.hdr ? " HDR" : ""}` : null,
          },
        });
      });
    }, signal);
    // Follow-up jobs are best-effort here; the sweeps pick up anything the queue refused.
    await enqueueEmbedding(photo.id).catch(() => undefined);
    await enqueueFaceDetection(photo.id).catch(() => undefined);
    await enqueueAnimalDetection(photo.id).catch(() => undefined);
  } catch (err) {
    // Cut short by a shutdown: the job is retried once the worker is back, so the row is left for that run.
    if (signal?.aborted && workerStopping()) throw err;
    if (signal?.aborted) {
      // Timed out: the retry may already have the row, so fail it only while it is still this run's.
      console.error(`[transcode-video] ${photo.id} timed out`);
      if (claimedAt) await db.photo.updateMany({ where: { id: photo.id, status: "PROCESSING", updatedAt: claimedAt }, data: { status: "FAILED", error: "Transcoding took too long and was stopped." } });
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[transcode-video] ${photo.id} failed:`, message);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    throw err;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}
