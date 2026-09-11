import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { cameraLabel, readExif, resolveTakenAt, type TakenAtResolution } from "@/lib/images/exif";
import { timezoneForCoords } from "@/lib/geo/tz";
import { sha256File } from "@/lib/media/hash";
import { heicToJpegBuffer, isHeic } from "@/lib/images/heic";
import { makeRenditions } from "@/lib/images/renditions";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone } from "@/lib/time/local-day";
import { enqueue } from "../boss";
import { QUEUES, type ProcessPhotoJob } from "../queues";
import { enqueueEmbedding } from "./embed-photo";
import { enqueueFaceDetection } from "./detect-faces";
import { enqueueAnimalDetection } from "./detect-animals";

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
      await enqueueAnimalDetection(photo.id);
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
    // A Takeout sidecar's date is authoritative (Google's own record of the capture time); EXIF supplies the zone.
    if (photo.takenAtSource === "SIDECAR" && photo.takenAt) resolved = sidecarResolution(photo.takenAt, resolved, exif, trip?.timezone ?? null, photo.gpsSource === "SIDECAR" ? { lat: photo.lat, lng: photo.lng } : null);
    if (!trip && resolved) {
      const candidates = await db.trip.findMany({ select: { id: true, startDate: true, endDate: true, timezone: true } });
      const match = pickTripByDay(candidates, resolved.wallDay);
      if (match) {
        trip = await db.trip.findUnique({ where: { id: match.id } });
        // Re-resolve now that we know the trip's zone (matters when EXIF has no offset and no GPS).
        if (resolved.source === "TRIP_TZ") resolved = resolveTakenAt(exif, trip?.timezone ?? null);
        else if (resolved.source === "SIDECAR" && photo.takenAt) resolved = sidecarResolution(photo.takenAt, resolveTakenAt(exif, trip?.timezone ?? null), exif, trip?.timezone ?? null, photo.gpsSource === "SIDECAR" ? { lat: photo.lat, lng: photo.lng } : null);
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
    const sidecarGps = photo.gpsSource === "SIDECAR" && photo.lat !== null && photo.lng !== null;
    const contentHash = photo.contentHash ?? (await sha256File(localPath));
    await db.photo.update({
      where: { id: photo.id },
      data: {
        status: "READY",
        width,
        height,
        takenAt,
        takenAtSource,
        tzOffsetMin,
        lat: hasGps ? exif.lat : photo.gpsSource === "MANUAL" || sidecarGps ? photo.lat : null,
        lng: hasGps ? exif.lng : photo.gpsSource === "MANUAL" || sidecarGps ? photo.lng : null,
        altitude: hasGps ? exif.altitude : null,
        gpsSource: hasGps ? "EXIF" : photo.gpsSource === "MANUAL" ? "MANUAL" : sidecarGps ? "SIDECAR" : null,
        contentHash,
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
    await enqueueAnimalDetection(photo.id);

    // 7. Position GPS-less photos from any track covering that moment (handler lands in Phase 5)
    if (trip && !hasGps && !sidecarGps && takenAt) {
      await enqueue(QUEUES.geotagPhotos, { tripId: trip.id }, { singletonKey: `geotag:${trip.id}`, singletonSeconds: 10, singletonNextSlot: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process-photo] ${photo.id} failed:`, message);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    throw err;
  }
}

/**
 * Keep a sidecar's instant and work out its zone: the EXIF offset when present, else the zone at the sidecar's or
 * EXIF's position, else the trip's zone, else UTC.
 */
function sidecarResolution(takenAt: Date, fromExif: TakenAtResolution | null, exif: { lat: number | null; lng: number | null }, tripTimezone: string | null, sidecarGps: { lat: number | null; lng: number | null } | null): TakenAtResolution {
  let tzOffsetMin: number;
  if (fromExif?.source === "EXIF_OFFSET") tzOffsetMin = fromExif.tzOffsetMin;
  else {
    const lat = sidecarGps?.lat ?? exif.lat;
    const lng = sidecarGps?.lng ?? exif.lng;
    const zone = (lat !== null && lng !== null ? timezoneForCoords(lat, lng) : null) ?? tripTimezone ?? "UTC";
    tzOffsetMin = offsetMinutesInZone(takenAt, zone);
  }
  return { takenAt, tzOffsetMin, source: "SIDECAR", wallDay: localDayFromOffset(takenAt, tzOffsetMin) };
}
