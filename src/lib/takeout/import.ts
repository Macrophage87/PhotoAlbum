import { createHash } from "node:crypto";
import sharp from "sharp";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { uniqueSlug } from "@/lib/trips/slug";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { EXT_BY_MIME, EXT_MIME } from "@/lib/media/mime";
import { claimContentHash } from "@/lib/media/content-hash";
import { processAgainIfStuck } from "@/lib/media/requeue";
import { safeArchivePath } from "./inbox";
import { albumFolderOf, captionFromTitle, isMediaName, isUnsupportedMediaName, isVideoName, pairSidecars, parseSidecar, type SidecarData } from "./sidecar";
import { readStreamToString, walkZip } from "./zip";
import { describeRepair, planSidecarRepair } from "./repair";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { timezoneForCoords } from "@/lib/geo/tz";
import { maxUploadBytes, tooBigMessage } from "@/lib/media/limits";
import { uploadByteLimits } from "@/lib/media/upload-limits";

export type ImportReport = { albums: { title: string; items: number; created: boolean }[]; duplicates: number; unsupported: number; failures: { file: string; reason: string }[]; noSidecar: number; repairs?: string[]; inTrash?: number; /** How many photos and clips the archive holds, known once its names are read, so a running import can show how far it has got. */ total?: number };

const IGNORED_JSON = new Set(["metadata.json", "print-subscriptions.json", "shared_album_comments.json", "user-generated-memory-titles.json"]);

/**
 * Import one Takeout archive: pass one indexes names and reads sidecars (small), pass two streams each media file to
 * a temp file while hashing it, skips duplicates by content hash or Google id, creates the row and files it through
 * the normal processing pipeline. Album folders become private collections. Never reads sharing state or face groups.
 */
/**
 * What an import says when whoever started it is being removed (see src/lib/auth/remove-member.ts): every photograph
 * it brings in would be theirs, handed over again, and a stranger's archive by then. Asked at the start, so an import
 * queued before the removal began never starts, and every 25 media files after that.
 */
export const STARTER_REMOVED = "Stopped: the member who started this import is being removed from the album. An admin can import the archive again; what came in so far stays, and is skipped next time.";

/** The same, for the member the photos are being brought in for (see TakeoutImport.ownerId). */
export const OWNER_REMOVED = "Stopped: the member these photos are being imported for is being removed from the album. What came in so far stays, and is skipped next time.";

async function starterStays(startedById: string, ownerId: string): Promise<void> {
  const starter = await db.user.findUnique({ where: { id: startedById }, select: { removingAt: true } });
  if (!starter || starter.removingAt) throw new Error(STARTER_REMOVED);
  if (ownerId === startedById) return;
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { removingAt: true } });
  if (!owner || owner.removingAt) throw new Error(OWNER_REMOVED);
}

/**
 * A real Google export barely compresses (photographs and video are compressed already), so everything it unpacks to
 * comes to about the archive's own size. An archive that unpacks to many times that is damaged or built to fill the
 * disk; the import stops once it has written this many times the archive's size, plus a little for small archives.
 */
export const UNPACK_LIMIT = { factor: 4, slackBytes: 256 * 1024 * 1024 };
export const TOO_MUCH_UNPACKED = "Stopped: this archive unpacks to far more than its own size, which a Google export never does. It may be damaged; export it from Google Takeout again. What came in so far stays.";
export const NOT_A_ZIP = "The archive could not be opened as a zip file. It may not have finished copying, or it may be damaged; copy it into the inbox again.";

/** A file larger than its kind may be, found while it is unpacked rather than from what the archive claims. */
class EntryTooBig extends Error {}

export async function importTakeoutArchive(importId: string): Promise<void> {
  const run = await db.takeoutImport.findUnique({ where: { id: importId } });
  if (!run || run.status !== "RUNNING") return;
  // Whose photographs these are: they are uploaded as theirs and their albums become their collections. A run from
  // before the choice existed has none, and was the starter's.
  const ownerId = run.ownerId ?? run.startedById;
  const limits = uploadByteLimits();
  const report: ImportReport = { albums: [], duplicates: 0, unsupported: 0, failures: [], noSidecar: 0, repairs: [], inTrash: 0 };
  let imported = 0, skipped = 0, failed = 0, collectionsCreated = 0, repaired = 0;
  const work = await mkdtemp(path.join(tmpdir(), "takeout-"));
  // A live run refreshes heartbeatAt every half minute; closeDeadImports() fails runs whose worker stopped doing so.
  const heartbeat = () => db.takeoutImport.updateMany({ where: { id: importId, status: "RUNNING" }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
  const pulse = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  try {
    await heartbeat();
    await starterStays(run.startedById, ownerId);
    const archive = safeArchivePath(run.archiveName);
    const archiveBytes = (await stat(archive).catch(() => null))?.size ?? 0;
    const unpackBudget = archiveBytes * UNPACK_LIMIT.factor + UNPACK_LIMIT.slackBytes;
    let unpacked = 0;
    // Pass one: names and sidecars.
    const names: string[] = [];
    const sidecars = new Map<string, SidecarData>();
    await walkZip(archive, async (entry, open) => {
      if (entry.isDirectory) return;
      names.push(entry.path);
      const base = path.basename(entry.path);
      if (base.endsWith(".json") && !IGNORED_JSON.has(base) && entry.size < 4 * 1024 * 1024) {
        try {
          sidecars.set(entry.path, parseSidecar(JSON.parse(await readStreamToString(await open()))));
        } catch {
          /* an unreadable sidecar just means no metadata for that file */
        }
      }
    }).catch((err) => {
      throw new Error(`${NOT_A_ZIP} (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
    });
    const pairs = pairSidecars(names);
    report.total = names.filter((n) => isMediaName(path.basename(n)) || isUnsupportedMediaName(path.basename(n))).length;
    await db.takeoutImport.updateMany({ where: { id: importId, status: "RUNNING" }, data: { report } }).catch(() => undefined);
    const albums = new Map<string, { id: string; created: boolean; items: number; title: string }>();
    /** Takeout bytes already matched to a photo brought in through the Picker, whose own bytes differ. */
    const pickedByHash = new Map<string, string>();
    const store = storage();

    /** Put a photo in the collection standing for its Google album folder, creating that collection once per run. */
    const joinAlbum = async (entryPath: string, photoId: string): Promise<void> => {
      const albumTitle = albumFolderOf(entryPath);
      if (!albumTitle) return;
      let album = albums.get(albumTitle);
      if (!album) {
        // Only a private, unshared collection may be reused; a public or link-shared one of the same name would
        // publish the whole album silently, so the import makes its own private collection instead. And only one of
        // the member whose photos these are: another member's "Beach" is theirs to arrange, not somewhere to pour 300
        // photos.
        const existing = await db.collection.findFirst({ where: { title: albumTitle, visibility: "PRIVATE", shareToken: null, createdById: ownerId }, orderBy: { createdAt: "asc" }, select: { id: true } });
        if (existing) album = { id: existing.id, created: false, items: 0, title: albumTitle };
        else {
          const slug = await uniqueSlug(albumTitle, async (s) => Boolean(await db.collection.findUnique({ where: { slug: s }, select: { id: true } })));
          const created = await db.collection.create({ data: { slug, title: albumTitle, description: "Imported from Google Photos", themeKey: "default", visibility: "PRIVATE", shareToken: null, createdById: ownerId }, select: { id: true } });
          album = { id: created.id, created: true, items: 0, title: albumTitle };
          collectionsCreated++;
        }
        albums.set(albumTitle, album);
      }
      const already = await db.collectionItem.findFirst({ where: { collectionId: album.id, photoId }, select: { id: true } });
      if (already) return;
      // After the last one, as everywhere else: a count lands on an existing place once anything has been taken out.
      const last = await db.collectionItem.findFirst({ where: { collectionId: album.id }, orderBy: { position: "desc" }, select: { position: true } });
      const position = (last?.position ?? -1) + 1;
      await db.collectionItem.create({ data: { collectionId: album.id, photoId, position, addedById: ownerId } }).catch(() => undefined);
      album.items++;
    };
    /** Undo joinAlbum's count for a row that is then thrown away (its membership goes with the row). */
    const unjoinAlbum = async (entryPath: string, photoId: string): Promise<void> => {
      const album = albums.get(albumFolderOf(entryPath) ?? "");
      if (album && (await db.collectionItem.findFirst({ where: { collectionId: album.id, photoId }, select: { id: true } }))) album.items--;
    };

    // Pass two: the media itself. The starter is asked about every 25 media files looked at, whatever became of
    // them: a re-import that is nearly all duplicates skips most of them, and is no less theirs.
    let looked = 0;
    await walkZip(archive, async (entry, open) => {
      if (entry.isDirectory) return;
      const file = path.basename(entry.path);
      if ((isMediaName(file) || isUnsupportedMediaName(file)) && ++looked % 25 === 1 && looked > 1) await starterStays(run.startedById, ownerId);
      if (!isMediaName(file)) {
        // A camera's raw file or an AVI is a photo or clip all the same: counted as one the album could not take.
        if (isUnsupportedMediaName(file)) { report.unsupported++; skipped++; }
        return;
      }
      const ext = file.toLowerCase().split(".").pop() ?? "";
      const mime = EXT_MIME[ext];
      if (!mime) { report.unsupported++; skipped++; return; }
      const sidecarPath = pairs.get(entry.path) ?? null;
      const meta = sidecarPath ? sidecars.get(sidecarPath) ?? null : null;
      if (!meta) report.noSidecar++;
      // The largest file of its kind the album takes from an upload, the same here. What the archive says the file
      // unpacks to is checked first, and the bytes themselves are counted as they come, in case it says wrong.
      const maxBytes = maxUploadBytes(mime, limits);
      try {
        if (entry.size > maxBytes) throw new EntryTooBig(tooBigMessage(entry.size, maxBytes));
        // Stream to a temp file while hashing, then decide.
        const tmp = path.join(work, `${imported + skipped + failed}.${ext}`);
        const hash = createHash("sha256");
        let size = 0;
        let overBudget = false;
        const tap = new Transform({
          transform(chunk, _e, cb) {
            size += chunk.length;
            unpacked += chunk.length;
            if (size > maxBytes) return cb(new EntryTooBig(tooBigMessage(size, maxBytes)));
            if (unpacked > unpackBudget) { overBudget = true; return cb(new Error(TOO_MUCH_UNPACKED)); }
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        try {
          await pipeline(await open(), tap, createWriteStream(tmp));
        } catch (err) {
          await rm(tmp, { force: true });
          if (overBudget) throw new AbortRun(TOO_MUCH_UNPACKED);
          throw err;
        }
        // Every empty file has the same hash, so it would be skipped as a duplicate of the first; it is a failure.
        if (size === 0) throw new Error("The file in the archive is empty (0 bytes).");
        const contentHash = hash.digest("hex");
        // A row an earlier run made but never finished (it has no file: "pending") is not the photo being in the
        // album; it is left over from a failure, and this run takes its place rather than skipping it for good.
        const orphans = { sourceKind: "TAKEOUT" as const, originalPath: "pending", OR: [{ contentHash }, ...(meta?.googleId ? [{ sourceId: meta.googleId }] : [])] };
        for (const o of await db.photo.findMany({ where: orphans, select: { id: true } })) {
          await store.deletePrefix(`photos/${o.id}`).catch(() => undefined);
          await db.photo.delete({ where: { id: o.id } }).catch(() => undefined);
        }
        const sameFile = { originalPath: { not: "pending" }, OR: [{ contentHash }, ...(meta?.googleId ? [{ sourceKind: "TAKEOUT" as const, sourceId: meta.googleId }] : [])] };
        let dupe = await db.photo.findFirst({ where: { trashedAt: null, ...sameFile }, select: dupeSelect });
        // Somebody put this one in the trash. The import neither brings it back (it was deleted on purpose) nor
        // repairs or files it where nobody can see it; the report says how many were passed over so.
        if (!dupe && (await db.photo.findFirst({ where: { trashedAt: { not: null }, ...sameFile }, select: { id: true } }))) {
          report.inTrash = (report.inTrash ?? 0) + 1;
          skipped++;
          await rm(tmp, { force: true });
          return;
        }
        if (!dupe) {
          // The same bytes again later in the archive (an album folder's copy, under another name) are that same
          // Picker photo, found by name and time the first time round.
          const known = pickedByHash.get(contentHash);
          dupe = known ? await db.photo.findFirst({ where: { id: known, trashedAt: null }, select: dupeSelect }) : await pickedCopyOf(file, meta, ownerId, isVideoName(file) ? null : tmp);
          if (dupe) pickedByHash.set(contentHash, dupe.id);
        }
        if (dupe) {
          // Already in the album: keep the bytes we have, but let the sidecar fill in whatever is still missing, and
          // put the photo in this Google album's collection all the same.
          report.duplicates++;
          skipped++;
          await rm(tmp, { force: true });
          // Its file is here but it never became a picture (a restart between storing and queueing it): queue it now,
          // before the repair below changes it.
          await processAgainIfStuck(dupe);
          const plan = planSidecarRepair(dupe, meta);
          if (plan) {
            await db.photo.update({ where: { id: dupe.id }, data: plan.data });
            if (plan.filled.includes("date")) await refileByDate(dupe.id);
            repaired++;
            if (report.repairs!.length < 200) report.repairs!.push(describeRepair(dupe.originalName, plan.filled));
          }
          await joinAlbum(entry.path, dupe.id);
          return;
        }
        const isVideo = isVideoName(file);
        // The hash is only given to the row once its bytes are stored (claimContentHash below), so a row whose
        // storing failed can never be mistaken for the photo being in the album.
        const photo = await db.photo.create({
          data: {
            uploaderId: ownerId,
            kind: isVideo ? "VIDEO" : "PHOTO",
            sourceKind: "TAKEOUT",
            sourceId: meta?.googleId ?? null,
            status: "PENDING",
            originalName: file,
            mimeType: mime,
            storageKey: "pending",
            originalPath: "pending",
            sizeBytes: 0,
            caption: captionFromTitle(meta?.title ?? null, file),
            context: meta?.description ?? null,
            contextUpdatedAt: meta?.description ? new Date() : null,
            takenAt: meta?.takenAt ?? null,
            takenAtSource: meta?.takenAt ? "SIDECAR" : null,
            lat: meta?.lat ?? null,
            lng: meta?.lng ?? null,
            gpsSource: meta?.lat !== null && meta?.lat !== undefined ? "SIDECAR" : null,
          },
        });
        const storageKey = `photos/${photo.id}`;
        const originalPath = `${storageKey}/original.${EXT_BY_MIME[mime]}`;
        let raced: { id: string } | null;
        try {
          const { bytes } = await store.putStream(originalPath, createReadStream(tmp), { maxBytes });
          await rm(tmp, { force: true });
          // Into its album before it takes the hash, so everything that can still fail leaves only this unclaimed row.
          await joinAlbum(entry.path, photo.id);
          // The same bytes may have arrived by upload while this one was being stored.
          raced = await claimContentHash(photo.id, contentHash, { storageKey, originalPath, sizeBytes: bytes });
        } catch (err) {
          // Nothing half-done is left: no row that looks imported and no bytes nobody will process. Importing the
          // archive again then imports this one afresh.
          await unjoinAlbum(entry.path, photo.id).catch(() => undefined);
          await store.deletePrefix(storageKey).catch(() => undefined);
          await db.photo.delete({ where: { id: photo.id } }).catch(() => undefined);
          throw err;
        }
        if (raced) {
          await unjoinAlbum(entry.path, photo.id).catch(() => undefined);
          await store.deletePrefix(storageKey).catch(() => undefined);
          await db.photo.delete({ where: { id: photo.id } }).catch(() => undefined);
          report.duplicates++;
          skipped++;
          await joinAlbum(entry.path, raced.id);
          return;
        }
        // From here the row has its hash and another upload may already have been matched to it, so it is kept
        // whatever happens and says what went wrong.
        try {
          if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: null });
          else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: null });
        } catch (err) {
          await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => undefined);
          throw err;
        }
        imported++;
      } catch (err) {
        // Not one file going wrong but the archive itself: the whole run stops.
        if (err instanceof AbortRun) throw err;
        failed++;
        if (report.failures.length < 50) report.failures.push({ file, reason: err instanceof Error ? err.message.slice(0, 120) : String(err) });
      }
      if ((imported + skipped + failed) % 25 === 0) await db.takeoutImport.update({ where: { id: importId }, data: { imported, skipped, failed, repaired, collectionsCreated } }).catch(() => undefined);
    });
    report.albums = [...albums.values()].map((a) => ({ title: a.title, items: a.items, created: a.created }));
    await db.takeoutImport.update({ where: { id: importId }, data: { status: "ENDED", imported, skipped, failed, repaired, collectionsCreated, report, endedAt: new Date() } });
    console.log(`[takeout] ${run.archiveName}: ${imported} imported, ${skipped} skipped, ${repaired} repaired, ${failed} failed, ${collectionsCreated} private collections created`);
  } catch (err) {
    report.failures.push({ file: run.archiveName, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    await db.takeoutImport.update({ where: { id: importId }, data: { status: "FAILED", imported, skipped, failed, repaired, collectionsCreated, report, endedAt: new Date() } }).catch(() => undefined);
    console.error(`[takeout] ${run.archiveName} failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  } finally {
    clearInterval(pulse);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Thrown from inside one file's work to stop the whole run, past the per-file catch. */
class AbortRun extends Error {}

const dupeSelect = { id: true, lat: true, lng: true, gpsSource: true, placeSetById: true, takenAt: true, takenAtSource: true, context: true, caption: true, sourceId: true, originalName: true, tripId: true, kind: true, status: true, originalPath: true, updatedAt: true } as const;

/** Time zones are whole quarter hours apart, so the same moment read in two zones differs by a multiple of this. */
const QUARTER_HOUR_MS = 15 * 60_000;
/** The furthest apart two readings of one moment can be: the widest gap between the world's time zones. */
const WIDEST_ZONE_GAP_MS = 26 * 3600_000;

/**
 * The same Google photo brought in earlier through the Picker. Its bytes differ (Google strips the position from a
 * Picker download) and its id is the Picker's rather than the one in the sidecar, so neither usual test finds it;
 * the file name and the capture time do. The time is compared to the second but allowed any whole number of quarter
 * hours apart, because the Picker copy's date came from its EXIF and may have been read in another zone.
 *
 * Any member's Picker copy counts: one member picks the trip's photos, another admin imports the family export later,
 * and the same photographs must not come in twice (#106). Another member's copy must match on its pixel size as well,
 * though, which is checked when both sizes are known; a name and a time alone are only enough for the owner's own.
 * A match is repaired and filed in the owner's own collection for its album, as any duplicate is, never in a
 * collection of whoever picked it.
 */
async function pickedCopyOf(file: string, meta: SidecarData | null, ownerId: string, imagePath: string | null) {
  if (!meta?.takenAt) return null;
  const at = meta.takenAt.getTime();
  // Its pixel size, when it can be read, must be the Picker copy's too (either way round: one may be rotated).
  const size = imagePath ? await sharp(imagePath).metadata().catch(() => null) : null;
  const known = Boolean(size?.width && size.height);
  const sameSize = (c: { width: number | null; height: number | null; uploaderId: string }) => {
    if (!known || c.width === null || c.height === null) return c.uploaderId === ownerId;
    return [size!.width!, size!.height!].sort().join("x") === [c.width, c.height].sort().join("x");
  };
  const candidates = await db.photo.findMany({
    where: { sourceKind: "GOOGLE_PICKER", trashedAt: null, originalName: { equals: file, mode: "insensitive" }, takenAt: { gte: new Date(at - WIDEST_ZONE_GAP_MS), lte: new Date(at + WIDEST_ZONE_GAP_MS) } },
    select: { ...dupeSelect, width: true, height: true, uploaderId: true },
  });
  const offBy = (t: Date | null) => {
    const d = Math.abs((t?.getTime() ?? Infinity) - at);
    const rest = d % QUARTER_HOUR_MS;
    return Math.min(rest, QUARTER_HOUR_MS - rest) <= 1000 ? d : Infinity;
  };
  // Closest in time first, and the owner's own before another member's at the same distance.
  const rank = (c: { takenAt: Date | null; uploaderId: string }) => offBy(c.takenAt) * 2 + (c.uploaderId === ownerId ? 0 : 1);
  return candidates.filter((c) => sameSize(c) && offBy(c.takenAt) < Infinity).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const HEARTBEAT_MS = 30_000;
/** A run whose heartbeat is this old has lost its worker (a restart mid-import) and is closed as failed. */
export const DEAD_IMPORT_MS = 10 * 60_000;

/** Close runs left RUNNING by a worker that died; called from the admin page and before a new import starts. */
export async function closeDeadImports(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEAD_IMPORT_MS);
  const r = await db.takeoutImport.updateMany({
    where: { status: "RUNNING", OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }] },
    data: { status: "FAILED", endedAt: now, report: { albums: [], duplicates: 0, unsupported: 0, noSidecar: 0, failures: [{ file: "(import)", reason: "The import was interrupted by a restart. Import the archive again; items already in the album are skipped." }] } },
  });
  return r.count;
}

/**
 * A repaired date can mean the photo belongs to a different day, and so to a different trip and activity. Work out
 * the zone the way processing does (the position if there is one, else the trip's, else UTC) and re-file it through
 * the same path a date correction takes, so an activity a member chose stays chosen and a pin interpolated from a
 * track at the old, wrong time is dropped.
 */
async function refileByDate(photoId: string): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, takenAt: true, takenAtSource: true, dateSetById: true, tripId: true, uploaderId: true, lat: true, lng: true, gpsSource: true, activityId: true, activitySetById: true, trip: { select: { timezone: true } } } });
  if (!photo?.takenAt) return;
  const zone = (photo.lat !== null && photo.lng !== null && photo.gpsSource !== "TRACK" ? timezoneForCoords(photo.lat, photo.lng) : null) ?? photo.trip?.timezone ?? "UTC";
  await applyPhotoInstant(photo, photo.takenAt, offsetMinutesInZone(photo.takenAt, zone), photo.takenAtSource ?? "SIDECAR", photo.dateSetById);
}
