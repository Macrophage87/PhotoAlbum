import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { sha256File } from "@/lib/media/hash";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";
import { ffmpeg, posterArgs, probe, transcodeArgs } from "@/lib/video/ffmpeg";
import { pickActivityByTime, pickTripByDay, whoWasThere } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone } from "@/lib/time/local-day";
import { withHeavyLock } from "../heavy-lock";
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
 * as the authority, even though the browser checks first. Runs under the heavy-work lock.
 */
export async function transcodeVideo(job: TranscodeVideoJob): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId } });
  if (!photo) return;
  await db.photo.update({ where: { id: photo.id }, data: { status: "PROCESSING", error: null } });
  const store = storage();
  const input = store.localPath?.(photo.originalPath);
  if (!input) throw new Error("transcode-video requires a storage driver with local paths");
  const work = await mkdtemp(path.join(tmpdir(), "clip-"));
  try {
    await withHeavyLock(async () => {
      const info = await probe(input);
      const limit = env().MAX_CLIP_SECONDS;
      if (info.durationS !== null && info.durationS > limit) throw new Error(tooLongMessage(info.durationS, limit));

      const mp4 = path.join(work, "video.mp4");
      const poster = path.join(work, "poster.jpg");
      await ffmpeg(transcodeArgs(input, mp4, info));
      await ffmpeg(posterArgs(mp4, poster, info.durationS));
      const out = await probe(mp4);
      const mp4Key = `${photo.storageKey}/video.mp4`;
      const posterKey = `${photo.storageKey}/poster.jpg`;
      await store.putBuffer(mp4Key, await readFile(mp4));
      await store.putBuffer(posterKey, await readFile(poster));
      const { renditions } = await makeRenditions(poster, photo.storageKey, (key, buf) => store.putBuffer(key, buf));
      const bytes = (await stat(mp4)).size;

      // Dates: a Takeout sidecar's date wins (Google's own record of when it was filmed), then the container's
      // creation time, then the file's modified time sent by the browser, then upload time.
      const mtimeHeader = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified;
      const fromSidecar = photo.takenAtSource === "SIDECAR" && photo.takenAt ? photo.takenAt : null;
      let instant = fromSidecar ?? info.createdAt ?? (mtimeHeader && Number.isFinite(mtimeHeader) ? new Date(mtimeHeader) : photo.createdAt);
      let takenAtSource: "SIDECAR" | "EXIF_OFFSET" | "FILE_MTIME" | "UPLOAD_TIME" = fromSidecar ? "SIDECAR" : info.createdAt ? "EXIF_OFFSET" : mtimeHeader ? "FILE_MTIME" : "UPLOAD_TIME";
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
      const tzOffsetMin = trip ? offsetMinutesInZone(instant, trip.timezone) : 0;
      let activityId: string | null = null;
      if (trip) {
        const activities = await db.activity.findMany({ where: { tripId: trip.id, ...whoWasThere(photo.uploaderId) }, select: { id: true, startTime: true, endTime: true } });
        activityId = pickActivityByTime(activities, instant)?.id ?? null;
      }
      const videoRenditions: VideoRenditions = { mp4: { key: mp4Key, w: out.width ?? 0, h: out.height ?? 0, bytes }, poster: { key: posterKey } };
      const contentHash = photo.contentHash ?? (await sha256File(input));
      await db.photo.update({
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
          takenAt: instant,
          takenAtSource,
          tzOffsetMin,
          tripId: trip?.id ?? null,
          activityId,
          camera: info.videoCodec ? `${info.videoCodec}${info.hdr ? " HDR" : ""}` : null,
        },
      });
    });
    // Follow-up jobs are best-effort here; the sweeps pick up anything the queue refused.
    await enqueueEmbedding(photo.id).catch(() => undefined);
    await enqueueFaceDetection(photo.id).catch(() => undefined);
    await enqueueAnimalDetection(photo.id).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[transcode-video] ${photo.id} failed:`, message);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
