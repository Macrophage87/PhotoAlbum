import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { cameraLabel, readExif, resolveDigitizedTakenAt, resolveTakenAt, type TakenAtResolution } from "@/lib/images/exif";
import { resolveFilenameTakenAt } from "@/lib/images/filename-date";
import { timezoneForCoords } from "@/lib/geo/tz";
import { sha256File } from "@/lib/media/hash";
import { heicToJpegBuffer, isHeic } from "@/lib/images/heic";
import { makeRenditions } from "@/lib/images/renditions";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { readGPano } from "@/lib/images/panorama-read";
import { editsSchema, hasEdits, type PhotoEdits } from "@/lib/images/edits";
import { pickActivityByTime, pickTripByDay, whoWasThere } from "@/lib/photos/assign";
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
/** A HEIC original cannot be read by sharp, so a re-render uses the JPEG made at upload, or makes one again. */
async function heicSource(store: ReturnType<typeof storage>, storageKey: string, localPath: string): Promise<string | Buffer> {
  const converted = store.localPath?.(`${storageKey}/original-converted.jpg`);
  if (converted && existsSync(converted)) return converted;
  return heicToJpegBuffer(localPath);
}

/** The stored instructions, or null when the item has never been edited or the row holds something unreadable. */
export function editsOf(raw: unknown): PhotoEdits | null {
  if (!raw) return null;
  const parsed = editsSchema.safeParse(raw);
  return parsed.success && hasEdits(parsed.data) ? parsed.data : null;
}

export async function processPhoto(job: ProcessPhotoJob): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId } });
  if (!photo) return;
  await db.photo.update({ where: { id: photo.id }, data: { status: "PROCESSING", error: null } });

  try {
    const store = storage();
    const localPath = store.localPath?.(photo.originalPath);
    if (!localPath) throw new Error("process-photo requires a storage driver with local paths");

    // A 3D scan has no pixels to read or render: it is dated by the file itself, filed on a trip by that date, and
    // otherwise kept exactly as it arrived. A poster for the grids comes later, from the first member to open it.
    if (photo.kind === "SCAN") {
      const mtimeHeader = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified;
      const s = mtimeHeader && Number.isFinite(mtimeHeader) ? null : await stat(localPath).catch(() => null);
      const takenAt = mtimeHeader && Number.isFinite(mtimeHeader) ? new Date(mtimeHeader) : s ? s.mtime : photo.createdAt;
      const takenAtSource = mtimeHeader && Number.isFinite(mtimeHeader) ? "FILE_MTIME" : s ? "FILE_MTIME" : "UPLOAD_TIME";
      await db.photo.update({ where: { id: photo.id }, data: { status: "READY", takenAt, takenAtSource, tzOffsetMin: photo.tzOffsetMin ?? 0 } });
      await applyPhotoInstant({ id: photo.id, tripId: photo.tripId, gpsSource: photo.gpsSource, activityId: photo.activityId, activitySetById: photo.activitySetById }, takenAt, photo.tzOffsetMin ?? 0, takenAtSource, null, { geotag: false });
      return;
    }

    // Posters of external videos carry no EXIF worth trusting and their date and trip were set by the member:
    // make renditions and stop, never touching dates, GPS or trip assignment.
    if (job.mode === "renditions" || photo.kind === "EXTERNAL_VIDEO") {
      // Also the path a darkroom edit takes: the renditions are made again from the untouched original with the
      // current instructions on them, which is what makes an edit undoable by simply forgetting it.
      const from = isHeic(photo.mimeType, photo.originalName) ? await heicSource(store, photo.storageKey, localPath) : localPath;
      const gpano = photo.kind === "PHOTO" ? await readGPano(localPath) : null;
      const { width, height, renditions, panorama } = await makeRenditions(from, photo.storageKey, (key, buf) => store.putBuffer(key, buf), editsOf(photo.edits), gpano);
      await db.photo.update({ where: { id: photo.id }, data: { status: "READY", width, height, renditions, panorama, panoProjection: gpano?.projection ?? null } });
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
    // The name is read only when the file itself says nothing: a phone's IMG_20250812_143015 is the capture time,
    // where the file's modified time is usually just when it was copied onto something.
    // In order of how much each can be trusted: when the shutter fired, then the capture time in the file's name,
    // then DateTimeDigitized — which an editor may have rewritten to the day it exported the file, so it comes last
    // of the readable sources and is recorded under its own name rather than as the camera's word.
    let resolved =
      resolveTakenAt(exif, trip?.timezone ?? null) ??
      resolveFilenameTakenAt(photo.originalName, trip?.timezone ?? null) ??
      resolveDigitizedTakenAt(exif, trip?.timezone ?? null);
    // A Takeout sidecar's date is authoritative (Google's own record of the capture time); EXIF supplies the zone.
    if (photo.takenAtSource === "SIDECAR" && photo.takenAt) resolved = sidecarResolution(photo.takenAt, resolved, exif, trip?.timezone ?? null, photo.gpsSource === "SIDECAR" ? { lat: photo.lat, lng: photo.lng } : null);
    if (!trip && resolved) {
      // Only trips this member was on, where anybody said who was on them; a clock cannot tell two families apart.
      const candidates = await db.trip.findMany({ where: whoWasThere(photo.uploaderId), select: { id: true, startDate: true, endDate: true, timezone: true } });
      const match = pickTripByDay(candidates, resolved.wallDay);
      if (match) {
        trip = await db.trip.findUnique({ where: { id: match.id } });
        // Re-resolve now that we know the trip's zone (matters when EXIF has no offset and no GPS).
        if (resolved.source === "TRIP_TZ") resolved = resolveTakenAt(exif, trip?.timezone ?? null);
        else if (resolved.source === "FILE_NAME") resolved = resolveFilenameTakenAt(photo.originalName, trip?.timezone ?? null);
        else if (resolved.source === "EXIF_CREATED") resolved = resolveDigitizedTakenAt(exif, trip?.timezone ?? null);
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
        const candidates = await db.trip.findMany({ where: whoWasThere(photo.uploaderId), select: { id: true, startDate: true, endDate: true, timezone: true } });
        // Each trip judges the instant in its own zone; still require exactly one match.
        const matches = candidates.filter((c) => pickTripByDay([c], localDayFromOffset(takenAt!, offsetMinutesInZone(takenAt!, c.timezone))));
        if (matches.length === 1) trip = await db.trip.findUnique({ where: { id: matches[0].id } });
      }
      tzOffsetMin = trip ? offsetMinutesInZone(takenAt, trip.timezone) : 0;
    }

    // 5. Renditions. Google's panorama tags are read from the original file, which is the only place a camera says
    // that what looks like a wide photo is really a sweep of the whole horizon.
    const gpano = await readGPano(localPath);
    const { width, height, renditions, panorama } = await makeRenditions(source, photo.storageKey, (key, buf) => store.putBuffer(key, buf), editsOf(photo.edits), gpano);

    // 6. Activity assignment within the trip. A member who uploaded this into an activity, or put it there by hand,
    // has already answered the question — the time window does not get to overrule them.
    let activityId: string | null = null;
    const chosen = photo.activitySetById ? await db.activity.findFirst({ where: { id: photo.activityId ?? "", tripId: trip?.id ?? "" }, select: { id: true } }) : null;
    if (chosen) activityId = chosen.id;
    else if (trip && takenAt) {
      const activities = await db.activity.findMany({ where: { tripId: trip.id, ...whoWasThere(photo.uploaderId) }, select: { id: true, startTime: true, endTime: true } });
      activityId = pickActivityByTime(activities, takenAt)?.id ?? null;
    }

    const hasGps = exif.lat !== null && exif.lng !== null;
    // A position the album did not read out of this file: Google's sidecar, or the helper's guess at the place. Both
    // survive a re-process, since re-reading the same file will not produce a better one.
    const keptGps = (photo.gpsSource === "SIDECAR" || photo.gpsSource === "ESTIMATE") && photo.lat !== null && photo.lng !== null;
    const sidecarGps = keptGps && photo.gpsSource === "SIDECAR";
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
        lat: hasGps ? exif.lat : photo.gpsSource === "MANUAL" || keptGps ? photo.lat : null,
        lng: hasGps ? exif.lng : photo.gpsSource === "MANUAL" || keptGps ? photo.lng : null,
        altitude: hasGps ? exif.altitude : null,
        gpsSource: hasGps ? "EXIF" : photo.gpsSource === "MANUAL" ? "MANUAL" : keptGps ? photo.gpsSource : null,
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
        panorama,
        panoProjection: gpano?.projection ?? null,
        tripId: trip?.id ?? null,
        activityId,
        ...(photo.activitySetById && !chosen ? { activitySetById: null } : {}),
      },
    });

    await enqueueEmbedding(photo.id);
    await enqueueFaceDetection(photo.id);
    await enqueueAnimalDetection(photo.id);

    // 7. Position GPS-less photos from any track covering that moment (handler lands in Phase 5). A place the helper
    // guessed at does not count as positioned: a track that covers the moment is better than a guess.
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
