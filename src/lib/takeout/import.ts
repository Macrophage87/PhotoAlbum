import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import { safeArchivePath } from "./inbox";
import { albumFolderOf, isMediaName, isVideoName, pairSidecars, parseSidecar, type SidecarData } from "./sidecar";
import { readStreamToString, walkZip } from "./zip";

export type ImportReport = { albums: { title: string; items: number; created: boolean }[]; duplicates: number; unsupported: number; failures: { file: string; reason: string }[]; noSidecar: number };

const IGNORED_JSON = new Set(["metadata.json", "print-subscriptions.json", "shared_album_comments.json", "user-generated-memory-titles.json"]);

/**
 * Import one Takeout archive: pass one indexes names and reads sidecars (small), pass two streams each media file to
 * a temp file while hashing it, skips duplicates by content hash or Google id, creates the row and files it through
 * the normal processing pipeline. Album folders become private collections. Never reads sharing state or face groups.
 */
export async function importTakeoutArchive(importId: string): Promise<void> {
  const run = await db.takeoutImport.findUnique({ where: { id: importId } });
  if (!run || run.status !== "RUNNING") return;
  const report: ImportReport = { albums: [], duplicates: 0, unsupported: 0, failures: [], noSidecar: 0 };
  let imported = 0, skipped = 0, failed = 0, collectionsCreated = 0;
  const work = await mkdtemp(path.join(tmpdir(), "takeout-"));
  // A live run refreshes heartbeatAt every half minute; closeDeadImports() fails runs whose worker stopped doing so.
  const heartbeat = () => db.takeoutImport.updateMany({ where: { id: importId, status: "RUNNING" }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
  const pulse = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  try {
    await heartbeat();
    const archive = safeArchivePath(run.archiveName);
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
    });
    const pairs = pairSidecars(names);
    const albums = new Map<string, { id: string; created: boolean; items: number; title: string }>();
    const store = storage();

    // Pass two: the media itself.
    await walkZip(archive, async (entry, open) => {
      if (entry.isDirectory || !isMediaName(path.basename(entry.path))) return;
      const file = path.basename(entry.path);
      const ext = file.toLowerCase().split(".").pop() ?? "";
      const mime = EXT_MIME[ext];
      if (!mime) { report.unsupported++; skipped++; return; }
      const sidecarPath = pairs.get(entry.path) ?? null;
      const meta = sidecarPath ? sidecars.get(sidecarPath) ?? null : null;
      if (!meta) report.noSidecar++;
      try {
        // Stream to a temp file while hashing, then decide.
        const tmp = path.join(work, `${imported + skipped + failed}.${ext}`);
        const hash = createHash("sha256");
        const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
        await pipeline(await open(), tap, createWriteStream(tmp));
        const contentHash = hash.digest("hex");
        const dupe = await db.photo.findFirst({ where: { OR: [{ contentHash }, ...(meta?.googleId ? [{ sourceKind: "TAKEOUT" as const, sourceId: meta.googleId }] : [])] }, select: { id: true } });
        if (dupe) { report.duplicates++; skipped++; await rm(tmp, { force: true }); return; }
        const isVideo = isVideoName(file);
        const photo = await db.photo.create({
          data: {
            uploaderId: run.startedById,
            kind: isVideo ? "VIDEO" : "PHOTO",
            sourceKind: "TAKEOUT",
            sourceId: meta?.googleId ?? null,
            contentHash,
            status: "PENDING",
            originalName: file,
            mimeType: mime,
            storageKey: "pending",
            originalPath: "pending",
            sizeBytes: 0,
            caption: meta?.title && meta.title !== file ? meta.title : null,
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
        const { bytes } = await store.putStream(originalPath, createReadStream(tmp));
        await rm(tmp, { force: true });
        await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, sizeBytes: bytes } });
        // Album folder → private collection, created once per run and reused across archives of the same export.
        const albumTitle = albumFolderOf(entry.path);
        if (albumTitle) {
          let album = albums.get(albumTitle);
          if (!album) {
            // Only a private, unshared collection may be reused; a public or link-shared one of the same name would
            // publish the whole album silently, so the import makes its own private collection instead.
            const existing = await db.collection.findFirst({ where: { title: albumTitle, visibility: "PRIVATE", shareToken: null }, select: { id: true } });
            if (existing) album = { id: existing.id, created: false, items: 0, title: albumTitle };
            else {
              const slug = await uniqueSlug(albumTitle, async (s) => Boolean(await db.collection.findUnique({ where: { slug: s }, select: { id: true } })));
              const created = await db.collection.create({ data: { slug, title: albumTitle, description: "Imported from Google Photos", themeKey: "default", visibility: "PRIVATE", shareToken: null, createdById: run.startedById }, select: { id: true } });
              album = { id: created.id, created: true, items: 0, title: albumTitle };
              collectionsCreated++;
            }
            albums.set(albumTitle, album);
          }
          const position = await db.collectionItem.count({ where: { collectionId: album.id } });
          await db.collectionItem.create({ data: { collectionId: album.id, photoId: photo.id, position, addedById: run.startedById } }).catch(() => undefined);
          album.items++;
        }
        if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: null });
        else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: null });
        imported++;
      } catch (err) {
        failed++;
        if (report.failures.length < 50) report.failures.push({ file, reason: err instanceof Error ? err.message.slice(0, 120) : String(err) });
      }
      if ((imported + skipped + failed) % 25 === 0) await db.takeoutImport.update({ where: { id: importId }, data: { imported, skipped, failed, collectionsCreated } }).catch(() => undefined);
    });
    report.albums = [...albums.values()].map((a) => ({ title: a.title, items: a.items, created: a.created }));
    await db.takeoutImport.update({ where: { id: importId }, data: { status: "ENDED", imported, skipped, failed, collectionsCreated, report, endedAt: new Date() } });
    console.log(`[takeout] ${run.archiveName}: ${imported} imported, ${skipped} skipped, ${failed} failed, ${collectionsCreated} private collections created`);
  } catch (err) {
    report.failures.push({ file: run.archiveName, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    await db.takeoutImport.update({ where: { id: importId }, data: { status: "FAILED", imported, skipped, failed, collectionsCreated, report, endedAt: new Date() } }).catch(() => undefined);
    console.error(`[takeout] ${run.archiveName} failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  } finally {
    clearInterval(pulse);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
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
