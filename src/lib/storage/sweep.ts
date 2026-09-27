import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { liveImportKeys } from "@/lib/jobs/live";

/**
 * An uploaded track file no job has read in this long was left by an import that died with its worker: the job is
 * queued with no retry and expires after an hour, and only the job deletes its file. A Google export among them is
 * years of somebody's whereabouts, so it is not kept for ever by accident.
 */
export const IMPORT_ABANDONED_MS = 6 * 3600_000;

/**
 * Delete files under imports/ older than IMPORT_ABANDONED_MS that neither a track (a GPX or FIT file is kept with
 * the tracks it made) nor a live import job refers to. Nothing is deleted when the jobs cannot be read.
 */
export async function sweepImportFiles(now = new Date()): Promise<number> {
  const dir = storage().localPath?.("imports");
  if (!dir) return 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  if (!names.length) return 0;
  const live = await liveImportKeys();
  if (!live) return 0;
  const cutoff = now.getTime() - IMPORT_ABANDONED_MS;
  let gone = 0;
  for (const name of names) {
    const key = `imports/${name}`;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs >= cutoff || live.has(key)) continue;
    if (await db.track.findFirst({ where: { originalFile: key }, select: { id: true } })) continue;
    await storage().delete(key).then(() => gone++, (err) => console.error(`[sweep] could not delete ${key}`, err));
  }
  if (gone) console.warn(`[sweep] deleted ${gone} uploaded track file(s) whose import never finished`);
  return gone;
}

/**
 * A photo's own folder, once its row is gone. Rendering writes files minutes after the job read the row, so an item
 * deleted for good meanwhile has had its folder removed already and would get renditions back that nothing refers
 * to. True when the row was gone.
 */
export async function forgetFilesIfGone(photoId: string): Promise<boolean> {
  if (await db.photo.findUnique({ where: { id: photoId }, select: { id: true } })) return false;
  await storage().deletePrefix(`photos/${photoId}`).catch((err) => console.error(`[sweep] could not delete photos/${photoId}`, err));
  return true;
}

/**
 * A photos/<id> folder with no row this long after it was last written to is left from a delete whose file job was
 * never queued (a queue failure part-way through deleting a batch for good), or from a job that wrote into it after
 * the row went. Every way into the album makes the row before the folder, so a day is far past any upload in flight.
 */
export const ORPHAN_FOLDER_MS = 24 * 3600_000;

/** Delete photos/<id> folders that have had no row, and no write, for ORPHAN_FOLDER_MS. A folder whose row exists is never touched. */
export async function sweepOrphanPhotoFolders(now = new Date()): Promise<number> {
  const dir = storage().localPath?.("photos");
  if (!dir) return 0;
  const ids = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  const cutoff = now.getTime() - ORPHAN_FOLDER_MS;
  let gone = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = new Set((await db.photo.findMany({ where: { id: { in: batch } }, select: { id: true } })).map((r) => r.id));
    for (const id of batch) {
      if (rows.has(id) || (await lastWrite(path.join(dir, id))) >= cutoff) continue;
      // Asked again on its own just before it goes, so nothing listed a while ago is taken on stale word.
      if (await forgetFilesIfGone(id)) gone++;
    }
  }
  if (gone) console.warn(`[sweep] deleted ${gone} photo folder(s) whose item was deleted`);
  return gone;
}

/** The latest write to a folder or anything directly in it, in epoch ms. */
async function lastWrite(folder: string): Promise<number> {
  const own = await stat(folder).catch(() => null);
  let latest = own?.mtimeMs ?? Infinity;
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const s = await stat(path.join(folder, name)).catch(() => null);
    if (s) latest = Math.max(latest, s.mtimeMs);
  }
  return latest;
}

/** The hourly storage sweep. Each part stands alone, so one that fails does not keep the other from running. */
export async function sweepOrphanFiles(now = new Date()): Promise<void> {
  await sweepImportFiles(now).catch((err) => console.error("[sweep] track-file sweep failed", err));
  await sweepOrphanPhotoFolders(now).catch((err) => console.error("[sweep] photo-folder sweep failed", err));
}
