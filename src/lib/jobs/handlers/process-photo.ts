import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { cameraLabel, readExif, resolveTakenAt } from "@/lib/images/exif";
import { heicToJpegBuffer, isHeic } from "@/lib/images/heic";
import { makeRenditions } from "@/lib/images/renditions";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone } from "@/lib/time/local-day";
import { enqueue } from "../boss";
import { QUEUES, type ProcessPhotoJob } from "../queues";
import { enqueueEmbedding } from "./embed-photo";
import { enqueueFaceDetection } from "./detect-faces";

/**
 * Turn an uploaded original into a usable photo: EXIF, timezone-correct takenAt, GPS,
 * WebP renditions, then trip/activity assignment. Idempotent: re-running overwrites.
 */
export async function processPhoto(job: ProcessPhotoJob): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId } });
  if (!photo) return;
  await db.photo.update({ where: { id: photo.id }, data: { status: "PROCESSING", error: null } });

  try {
    const store = storage();
    const localPath = store.localPath?.(photo.originalPath);
    if (!localPath) throw new Error("process-photo requires a storage driver with local paths");

    // Posters of external videos carry no EXIF worth trusting and their date and trip were set by the member:
    // make renditions and stop, never touching dates, GPS or trip assignment.
    if (job.mode === "renditions" || photo.kind === "EXTERNAL_VIDEO") {
      const { width, height, renditions } = await makeRenditions(localPath, photo.storageKey, (key, buf) => store.putBuffer(key, buf));
      await db.photo.update({ where: { id: photo.id }, data: { status: "READY", width, height, renditions } });
      await enqueueEmbedding(photo.id);
    await enqueueFaceDetection(photo.id);
      return;
    }

    // 1. Source pixels (HEIC may need conversion)
    let source: string | Buffer = localPath;
    if (isHeic(photo.mimeType, photo.originalName)) {
      source = await heicToJpegBuffer(localPath);
      await store.putBuffer(`${photo.storageKey}/original-converted.jpg`, source);
    }

    // 2. EXIF from the original file (conversion can strip it)
    const exif = await readExif(localPath);

    // 3. Trip candidates: explicit trip wins, otherwise match by the photo's wall-clock day
    const explicitTrip = job.tripId ? await db.trip.findUnique({ where: { id: job.tripId } }) : photo.tripId ? await db.trip.findUnique({ where: { id: photo.tripId } }) : null;
    let trip = explicitTrip;
    let resolved = resolveTakenAt(exif, trip?.timezone ?? null);
    if (!trip && resolved) {
      const candidates = await db.trip.findMany({ select: { id: true, startDate: true, endDate: true, timezone: true } });
      const match = pickTripByDay(candidates, resolved.wallDay);
      if (match) {
        trip = await db.trip.findUnique({ where: { id: match.id } });
        // Re-resolve now that we know the trip's zone (matters when EXIF has no offset and no GPS).
        if (resolved.source === "TRIP_TZ") resolved = resolveTakenAt(exif, trip?.timezone ?? null);
      }
    }

    // 4. takenAt fallbacks when EXIF has no date
    let takenAt = resolved?.takenAt ?? null;
    let tzOffsetMin = resolved?.tzOffsetMin ?? null;
    let takenAtSource = resolved?.source ?? null;
    const mtimeHeader = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified;
    if (!takenAt) {
      if (mtimeHeader && Number.isFinite(mtimeHeader)) {
        takenAt = new Date(mtimeHeader);
        takenAtSource = "FILE_MTIME";
      } else {
        const s = await stat(localPath).catch(() => null);
        takenAt = s ? s.mtime : photo.createdAt;
        takenAtSource = s ? "FILE_MTIME" : "UPLOAD_TIME";
      }
      // No camera zone to go on: interpret the instant in the trip zone when we know it, else in UTC.
      if (!trip) {
        const candidates = await db.trip.findMany({ select: { id: true, startDate: true, endDate: true, timezone: true } });
        // Each trip judges the instant in its own zone; still require exactly one match.
        const matches = candidates.filter((c) => pickTripByDay([c], localDayFromOffset(takenAt!, offsetMinutesInZone(takenAt!, c.timezone))));
        if (matches.length === 1) trip = await db.trip.findUnique({ where: { id: matches[0].id } });
      }
      tzOffsetMin = trip ? offsetMinutesInZone(takenAt, trip.timezone) : 0;
    }

    // 5. Renditions
    const { width, height, renditions } = await makeRenditions(source, photo.storageKey, (key, buf) => store.putBuffer(key, buf));

    // 6. Activity assignment within the trip
    let activityId: string | null = null;
    if (trip && takenAt) {
      const activities = await db.activity.findMany({ where: { tripId: trip.id }, select: { id: true, startTime: true, endTime: true } });
      activityId = pickActivityByTime(activities, takenAt)?.id ?? null;
    }

    const hasGps = exif.lat !== null && exif.lng !== null;
    await db.photo.update({
      where: { id: photo.id },
      data: {
        status: "READY",
        width,
        height,
        takenAt,
        takenAtSource,
        tzOffsetMin,
        lat: hasGps ? exif.lat : photo.gpsSource === "MANUAL" ? photo.lat : null,
        lng: hasGps ? exif.lng : photo.gpsSource === "MANUAL" ? photo.lng : null,
        altitude: hasGps ? exif.altitude : null,
        gpsSource: hasGps ? "EXIF" : photo.gpsSource === "MANUAL" ? "MANUAL" : null,
        camera: cameraLabel(exif),
        lens: exif.lens,
        exif: {
          exposureTime: exif.exposureTime,
          fNumber: exif.fNumber,
          iso: exif.iso,
          focalLength: exif.focalLength,
          orientation: exif.orientation,
          offsetTimeOriginal: exif.offsetTimeOriginal,
          dateTimeOriginal: exif.dateTimeOriginal,
          ...(mtimeHeader && Number.isFinite(mtimeHeader) ? { fileLastModified: mtimeHeader } : {}),
        },
        renditions,
        tripId: trip?.id ?? null,
        activityId,
      },
    });

    await enqueueEmbedding(photo.id);
    await enqueueFaceDetection(photo.id);

    // 7. Position GPS-less photos from any track covering that moment (handler lands in Phase 5)
    if (trip && !hasGps && takenAt) {
      await enqueue(QUEUES.geotagPhotos, { tripId: trip.id }, { singletonKey: `geotag:${trip.id}`, singletonSeconds: 10, singletonNextSlot: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process-photo] ${photo.id} failed:`, message);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    throw err;
  }
}
