import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { publicScanCopy } from "@/lib/scans/public-copy";
import { cameraLabel, readExif, resolveDigitizedTakenAt, resolveTakenAt, type TakenAtResolution } from "@/lib/images/exif";
import { resolveFilenameTakenAt } from "@/lib/images/filename-date";
import { timezoneForCoords } from "@/lib/geo/tz";
import { sha256File } from "@/lib/media/hash";
import { heicToJpegBuffer, isHeic } from "@/lib/images/heic";
import { makeRenditions } from "@/lib/images/renditions";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { readGPano } from "@/lib/images/panorama-read";
import { editsSchema, hasEdits, type PhotoEdits } from "@/lib/images/edits";
import { pickTripByDay, whoWasThere } from "@/lib/photos/assign";
import { pickTripByCoverage } from "@/lib/photos/trip-by-coverage";
import { activityFor } from "@/lib/activities/reassign";
import { dateByHand, dateMovedSince, lockedPhoto, placeByHand } from "@/lib/photos/member-owned";
import { localDayFromOffset, offsetMinutesInZone, photoOffsetMin } from "@/lib/time/local-day";
import { enqueue } from "../boss";
import { QUEUES, type ProcessPhotoJob } from "../queues";
import { enqueueEmbedding } from "./embed-photo";
import { enqueueFaceDetection } from "./detect-faces";
import { enqueueAnimalDetection } from "./detect-animals";
import { workerStopping } from "../shutdown";
import { forgetFilesIfGone } from "@/lib/storage/sweep";

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

/** `signal` is pg-boss's: a run it has timed out writes nothing more, so the retry never races it. */
export async function processPhoto(job: ProcessPhotoJob, signal?: AbortSignal): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId } });
  // Deleted for good before its job ran, or while an earlier run of it was writing renditions (its retry lands here).
  if (!photo) return void (await forgetFilesIfGone(job.photoId));
  // A clip is made by the transcoder; sharp cannot read a frame of it, so the photo path would only mark it failed.
  if (photo.kind === "VIDEO") {
    await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: job.tripId ?? photo.tripId }, { singletonKey: `transcode:${photo.id}` });
    return;
  }
  // The stamp marks the row as this run's: a retry of a timed-out run stamps it again.
  const { updatedAt: claimedAt } = await db.photo.update({ where: { id: photo.id }, data: { status: "PROCESSING", error: null }, select: { updatedAt: true } });

  try {
    const store = storage();
    const localPath = store.localPath?.(photo.originalPath);
    if (!localPath) throw new Error("process-photo requires a storage driver with local paths");

    // A 3D scan has no pixels to read or render: it is dated by the file itself, filed on a trip by that date, and
    // otherwise kept exactly as it arrived. A poster for the grids comes later, from the first member to open it.
    if (photo.kind === "SCAN") {
      // The copy visitors are given, without what the app wrote into the file; made again on first request if this fails.
      await publicScanCopy(photo).catch(() => null);
      // With no offset of its own, an instant is read on its trip's clock (see `photoOffsetMin`), never as UTC.
      const scanTripId = job.tripId ?? photo.tripId;
      const zone = scanTripId ? (await db.trip.findUnique({ where: { id: scanTripId }, select: { timezone: true } }))?.timezone : null;
      // A date somebody gave it (by hand, or Google's own record) is kept: the file's modified time is only a guess.
      if (vouchedDate(photo)) {
        await db.photo.update({ where: { id: photo.id }, data: { status: "READY" } });
        await applyPhotoInstant(photo, photo.takenAt!, photoOffsetMin(photo.takenAt!, photo.tzOffsetMin, zone), photo.takenAtSource!, photo.dateSetById, { geotag: false });
        return;
      }
      const mtimeHeader = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified;
      const s = mtimeHeader && Number.isFinite(mtimeHeader) ? null : await stat(localPath).catch(() => null);
      const takenAt = mtimeHeader && Number.isFinite(mtimeHeader) ? new Date(mtimeHeader) : s ? s.mtime : photo.createdAt;
      const takenAtSource = mtimeHeader && Number.isFinite(mtimeHeader) ? "FILE_MTIME" : s ? "FILE_MTIME" : "UPLOAD_TIME";
      const tzOffsetMin = photoOffsetMin(takenAt, photo.tzOffsetMin, zone);
      await db.photo.update({ where: { id: photo.id }, data: { status: "READY", takenAt, takenAtSource, tzOffsetMin } });
      await applyPhotoInstant(photo, takenAt, tzOffsetMin, takenAtSource, null, { geotag: false });
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
      signal?.throwIfAborted();
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
    const resolveIn = (timezone: string | null) => {
      let r =
        resolveTakenAt(exif, timezone) ??
        resolveFilenameTakenAt(photo.originalName, timezone) ??
        resolveDigitizedTakenAt(exif, timezone);
      // A Takeout sidecar's date is authoritative (Google's own record of the capture time); EXIF supplies the zone.
      if (photo.takenAtSource === "SIDECAR" && photo.takenAt) r = sidecarResolution(photo.takenAt, r, exif, timezone, photo.gpsSource === "SIDECAR" ? { lat: photo.lat, lng: photo.lng } : null);
      // A date a member set by hand is their answer to "the camera was wrong": re-reading the camera does not undo it.
      if (photo.takenAtSource === "MANUAL" && photo.takenAt) {
        const tzOffsetMin = photoOffsetMin(photo.takenAt, photo.tzOffsetMin, timezone);
        r = { takenAt: photo.takenAt, tzOffsetMin, source: "MANUAL", wallDay: localDayFromOffset(photo.takenAt, tzOffsetMin) };
      }
      return r;
    };
    let resolved = resolveIn(trip?.timezone ?? null);
    // On none of the uploader's trips' days at all (a ride on the last evening that runs past midnight): the trip out
    // on an activity or a track at that moment is chosen once the row is locked (step 6), from what is there then.
    type Candidate = { id: string; startDate: Date; endDate: Date; timezone: string };
    let dayless: { candidates: Candidate[]; inZone: (timezone: string) => Pick<TakenAtResolution, "takenAt" | "tzOffsetMin" | "source"> | null } | null = null;
    if (!trip && resolved) {
      // Only trips this member was on, where anybody said who was on them; a clock cannot tell two families apart.
      const candidates = await db.trip.findMany({ where: whoWasThere(photo.uploaderId), select: { id: true, startDate: true, endDate: true, timezone: true } });
      const day = resolved.wallDay;
      const match = pickTripByDay(candidates, day);
      // A clock with no zone of its own is read in each trip's zone.
      if (!candidates.some((c) => pickTripByDay([c], day))) dayless = { candidates, inZone: (timezone) => resolveIn(timezone) };
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
        // On no trip's days: as above, once the row is locked.
        const instant = takenAt, source = takenAtSource!;
        if (matches.length === 0) dayless = { candidates, inZone: (timezone) => ({ takenAt: instant, tzOffsetMin: offsetMinutesInZone(instant, timezone), source }) };
      }
      tzOffsetMin = trip ? offsetMinutesInZone(takenAt, trip.timezone) : 0;
    }

    // 5. Renditions. Google's panorama tags are read from the original file, which is the only place a camera says
    // that what looks like a wide photo is really a sweep of the whole horizon.
    const gpano = await readGPano(localPath);
    const { width, height, renditions, panorama } = await makeRenditions(source, photo.storageKey, (key, buf) => store.putBuffer(key, buf), editsOf(photo.edits), gpano);
    signal?.throwIfAborted();

    const contentHash = photo.contentHash ?? (await sha256File(localPath));

    // 6. Write back. The row was read when the job started, and rendering takes a while: a member may have dated the
    // item, pinned or cleared its place, or filed it on an activity since. So the row is read again, locked, and
    // everything a member may have answered is worked out from that; what a member set is never written over.
    const settled = await db.$transaction(async (tx) => {
      const now = await lockedPhoto(tx, photo.id);
      if (!now) return null;
      // A date given (or changed) since the job read the row is newer than anything the job worked out: it stands,
      // and so does the trip it put the item on. A date a member set before is kept as it is, too (the job read the
      // same one, so its trip still follows from it).
      const moved = dateMovedSince(photo, now);
      const keepDate = moved || dateByHand(now);
      let date = keepDate ? { takenAt: now.takenAt, tzOffsetMin: now.tzOffsetMin } : { takenAt, tzOffsetMin };
      let source = takenAtSource;
      const decides = !moved && now.tripId === photo.tripId;
      let tripId = decides ? (trip?.id ?? null) : now.tripId;
      // On no trip's days: the single trip with an activity or a track running at the instant, as the trip's
      // activities and tracks stand now. Its zone then reads a clock that has none of its own; a kept date stays.
      if (decides && !tripId && dayless) {
        const d = dayless;
        const running = await pickTripByCoverage(d.candidates, now.uploaderId, (c) => (keepDate ? { takenAt: now.takenAt, source: now.takenAtSource } : d.inZone(c.timezone)), tx);
        const inZone = running && !keepDate ? d.inZone(running.timezone) : null;
        if (running) tripId = running.id;
        if (inZone) {
          date = { takenAt: inZone.takenAt, tzOffsetMin: inZone.tzOffsetMin };
          source = inZone.source;
        }
      }
      // Activity assignment within the trip. A member who uploaded this into an activity, or put it there (or took it
      // off) by hand, has already answered the question — the time window does not get to overrule them.
      const filing = await activityFor(now, tripId, date.takenAt, tx);
      // A place a member pinned, or took away, is theirs: the file's own GPS does not come back over it, and none of
      // the place is written at all.
      const byHand = placeByHand(now);
      const hasGps = !byHand && exif.lat !== null && exif.lng !== null;
      // A position the album did not read out of this file: Google's sidecar, or the helper's guess at the place.
      // Both survive a re-process, since re-reading the same file will not produce a better one.
      const keptGps = (now.gpsSource === "SIDECAR" || now.gpsSource === "ESTIMATE") && now.lat !== null && now.lng !== null;
      await tx.photo.update({
        where: { id: photo.id },
        data: {
          status: "READY",
          width,
          height,
          ...(keepDate ? {} : { takenAt: date.takenAt, takenAtSource: source, tzOffsetMin: date.tzOffsetMin }),
          ...(byHand
            ? {}
            : {
                lat: hasGps ? exif.lat : keptGps ? now.lat : null,
                lng: hasGps ? exif.lng : keptGps ? now.lng : null,
                altitude: hasGps ? exif.altitude : null,
                gpsSource: hasGps ? "EXIF" : keptGps ? now.gpsSource : null,
              }),
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
          tripId,
          activityId: filing.activityId,
          activitySetById: filing.activitySetById,
        },
      });
      return { tripId, takenAt: date.takenAt, positioned: hasGps || (keptGps && now.gpsSource === "SIDECAR") };
    });
    // Deleted for good while it was being rendered: what was just written has nothing to belong to.
    if (!settled) return void (await forgetFilesIfGone(photo.id));

    await enqueueEmbedding(photo.id);
    await enqueueFaceDetection(photo.id);
    await enqueueAnimalDetection(photo.id);

    // 7. Position GPS-less photos from any track covering that moment (handler lands in Phase 5). A place the helper
    // guessed at does not count as positioned: a track that covers the moment is better than a guess.
    if (settled.tripId && !settled.positioned && settled.takenAt) {
      await enqueue(QUEUES.geotagPhotos, { tripId: settled.tripId }, { singletonKey: `geotag:${settled.tripId}`, singletonSeconds: 10, singletonNextSlot: true });
    }
  } catch (err) {
    // Cut short by a shutdown: the job is retried once the worker is back, so the row is left for that run.
    if (signal?.aborted && workerStopping()) throw err;
    if (signal?.aborted) {
      // Timed out. Rendering cannot be interrupted, so the retry may already have the row (or have finished it):
      // fail it only while it is still this run's.
      console.error(`[process-photo] ${photo.id} timed out`);
      await db.photo.updateMany({ where: { id: photo.id, status: "PROCESSING", updatedAt: claimedAt }, data: { status: "FAILED", error: "Processing took too long and was stopped." } });
      await forgetFilesIfGone(photo.id);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    // No row to fail (it was deleted for good mid-run, which is also what failed the write): nothing is left to retry,
    // and whatever this run wrote goes.
    const failed = await db.photo.updateMany({ where: { id: photo.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    if (!failed.count && (await forgetFilesIfGone(photo.id))) return;
    console.error(`[process-photo] ${photo.id} failed:`, message);
    throw err;
  }
}

/** A date somebody vouched for — a member by hand, or Google's sidecar — which reading the file again must not replace. */
function vouchedDate(photo: { takenAt: Date | null; takenAtSource: string | null }): boolean {
  return photo.takenAt !== null && (photo.takenAtSource === "MANUAL" || photo.takenAtSource === "SIDECAR");
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
