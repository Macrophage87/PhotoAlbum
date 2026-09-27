import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { liveImportKeys } from "@/lib/jobs/live";
import { inboxDir } from "@/lib/takeout/inbox";
import { installIdentity } from "./identity";

/**
 * An uploaded track file no job has read in this long was left by an import that died with its worker: the job is
 * queued with no retry and expires after an hour, and only the job deletes its file. A Google export among them is
 * years of somebody's whereabouts, so it is not kept for ever by accident.
 */
export const IMPORT_ABANDONED_MS = 6 * 3600_000;

/** The only names the import route gives what it stores (`imports/<uuid>.<ext>`); anything else is not the sweep's. */
const IMPORT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/;

/**
 * Delete files under imports/ older than IMPORT_ABANDONED_MS that neither a track (a GPX or FIT file is kept with
 * the tracks it made) nor a live import job refers to. Only names the import route makes are touched, never a
 * Takeout inbox pointed at the same folder, and nothing at all when the jobs cannot be read or the database is not
 * this storage's (see identity.ts).
 */
export async function sweepImportFiles(now = new Date()): Promise<number> {
  const dir = storage().localPath?.("imports");
  if (!dir) return 0;
  const inbox = inboxDir();
  if (inbox && path.resolve(inbox) === path.resolve(dir)) return 0;
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => IMPORT_NAME.test(n));
  if (!names.length) return 0;
  const identity = await installIdentity();
  if (!identity.ok) {
    console.error(`[sweep] not sweeping uploaded track files: ${identity.problem}`);
    return 0;
  }
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
 * A photos/<id> folder with no row is only ever reported, never deleted by itself: a database that is not this
 * media's would find every folder orphaned, and copies made with rsync or tar keep old times, so no age proves a
 * folder abandoned. An admin moves what is found to the quarantine, within limits, and empties that separately.
 *
 * ORPHAN_FOLDER_MS is how long a folder with no row must have gone unwritten, anywhere inside it, to be reported.
 */
export const ORPHAN_FOLDER_MS = 7 * 24 * 3600_000;
/** How long a moved folder waits in the quarantine before it may be deleted. */
export const QUARANTINE_KEEP_MS = 30 * 24 * 3600_000;
/** The most folders one move may take: an album whose database has lost track of more than this needs a person. */
export const QUARANTINE_MAX = 200;
export const QUARANTINE_MAX_SHARE = 0.05;
/** How many of the found folders the Admin page names. */
const SAMPLE = 20;

/** Only folder names the album itself makes (a row's cuid), so nobody's own folder under photos/ is ever counted. */
const PHOTO_FOLDER = /^c[a-z0-9]{24}$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/** The latest write anywhere in a folder, in epoch ms. */
async function newestWrite(folder: string): Promise<number> {
  const own = await stat(folder).catch(() => null);
  let latest = own?.mtimeMs ?? Infinity;
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? await newestWrite(full) : ((await stat(full).catch(() => null))?.mtimeMs ?? latest));
  }
  return latest;
}

export type OrphanScan = { ok: false; problem: string } | { ok: true; orphans: string[]; folders: number };

/** photos/<cuid> folders with no row and nothing written in them for ORPHAN_FOLDER_MS. Changes nothing. */
export async function findOrphanPhotoFolders(now = new Date()): Promise<OrphanScan> {
  const identity = await installIdentity();
  if (!identity.ok) return identity;
  const dir = storage().localPath?.("photos");
  if (!dir) return { ok: true, orphans: [], folders: 0 };
  const ids = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && PHOTO_FOLDER.test(d.name)).map((d) => d.name);
  const cutoff = now.getTime() - ORPHAN_FOLDER_MS;
  const orphans: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = new Set((await db.photo.findMany({ where: { id: { in: batch } }, select: { id: true } })).map((r) => r.id));
    for (const id of batch) if (!rows.has(id) && (await newestWrite(path.join(dir, id))) < cutoff) orphans.push(id);
  }
  return { ok: true, orphans, folders: ids.length };
}

/** The hourly check: what it found is kept for the Admin page. */
export async function recordOrphanPhotoFolders(now = new Date()): Promise<number | null> {
  const scan = await findOrphanPhotoFolders(now);
  if (!scan.ok) {
    console.error(`[sweep] not checking photo folders: ${scan.problem}`);
    return null;
  }
  const data = { orphanFolderCount: scan.orphans.length, orphanFolderSample: scan.orphans.slice(0, SAMPLE), orphanFoldersCheckedAt: now };
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", ...data }, update: data });
  if (scan.orphans.length) console.warn(`[sweep] ${scan.orphans.length} photo folder(s) have no photo in this album; see the Admin page`);
  return scan.orphans.length;
}

export type QuarantineResult = { ok: boolean; message: string; moved?: number };

/**
 * Move the photo folders with no row into quarantine/<today>/, when an admin has typed how many there are. Refused
 * when the database and the storage are not the same album's, when the album has no photos at all, and when more
 * would move than QUARANTINE_MAX or QUARANTINE_MAX_SHARE of all photo folders: each of those says the database,
 * not the folders, is what is wrong.
 */
export async function quarantineOrphanPhotoFolders(expected: number, now = new Date()): Promise<QuarantineResult> {
  const scan = await findOrphanPhotoFolders(now);
  if (!scan.ok) return { ok: false, message: `Nothing was moved. ${scan.problem}` };
  if ((await db.photo.count()) === 0) return { ok: false, message: "Nothing was moved: this album has no photos at all, so its database is probably not the one these files belong to." };
  const { orphans, folders } = scan;
  if (!orphans.length) return { ok: true, message: "No photo folders are waiting to be moved.", moved: 0 };
  if (orphans.length !== expected) return { ok: false, message: `Nothing was moved: ${orphans.length} folders have no photo now, not ${expected}. Check the number and type it again.` };
  if (orphans.length > QUARANTINE_MAX || orphans.length > folders * QUARANTINE_MAX_SHARE) {
    return { ok: false, message: `Nothing was moved: ${orphans.length} of ${folders} photo folders would go, more than one move may take (${QUARANTINE_MAX}, or ${Math.round(QUARANTINE_MAX_SHARE * 100)}% of them). That many usually means the database is not this media's; see "The quarantine" in docs/DEPLOY.md.` };
  }
  const store = storage();
  const day = now.toISOString().slice(0, 10);
  const into = store.localPath!(`quarantine/${day}`);
  await mkdir(into, { recursive: true });
  let moved = 0;
  for (const id of orphans) {
    // Asked again on its own just before it moves, so nothing listed a moment ago is taken on stale word.
    if (await db.photo.findUnique({ where: { id }, select: { id: true } })) continue;
    await rename(store.localPath!(`photos/${id}`), path.join(into, id)).then(() => moved++, (err) => console.error(`[sweep] could not move photos/${id}`, err));
  }
  await recordOrphanPhotoFolders(now);
  console.warn(`[sweep] moved ${moved} photo folder(s) with no photo to quarantine/${day}`);
  return { ok: true, message: `Moved ${moved} folder${moved === 1 ? "" : "s"} to quarantine/${day}. They are deleted only when you empty the quarantine, after ${QUARANTINE_KEEP_MS / 86_400_000} days.`, moved };
}

export type QuarantineDay = { day: string; folders: number };

/** What is in the quarantine, a day at a time. */
export async function quarantineContents(): Promise<QuarantineDay[]> {
  const dir = storage().localPath?.("quarantine");
  if (!dir) return [];
  const days = (await readdir(dir).catch(() => [] as string[])).filter((d) => DAY_FOLDER.test(d)).sort();
  return Promise.all(days.map(async (day) => ({ day, folders: (await readdir(path.join(dir, day)).catch(() => [])).length })));
}

/** Delete the quarantine's days that are older than QUARANTINE_KEEP_MS; later ones stay. Only for this album's own storage. */
export async function emptyQuarantine(now = new Date()): Promise<QuarantineResult> {
  const identity = await installIdentity();
  if (!identity.ok) return { ok: false, message: `Nothing was deleted. ${identity.problem}` };
  const dir = storage().localPath?.("quarantine");
  if (!dir) return { ok: true, message: "The quarantine is empty.", moved: 0 };
  const cutoff = now.getTime() - QUARANTINE_KEEP_MS;
  let folders = 0;
  for (const { day, folders: n } of await quarantineContents()) {
    if (Date.parse(`${day}T00:00:00Z`) >= cutoff) continue;
    await rm(path.join(dir, day), { recursive: true, force: true });
    folders += n;
  }
  return { ok: true, message: folders ? `Deleted ${folders} folder${folders === 1 ? "" : "s"} that had been in the quarantine for over ${QUARANTINE_KEEP_MS / 86_400_000} days.` : `Nothing in the quarantine is over ${QUARANTINE_KEEP_MS / 86_400_000} days old yet.`, moved: folders };
}

/** The hourly storage job. Each part stands alone, so one that fails does not keep the other from running. */
export async function sweepOrphanFiles(now = new Date()): Promise<void> {
  await sweepImportFiles(now).catch((err) => console.error("[sweep] track-file sweep failed", err));
  await recordOrphanPhotoFolders(now).catch((err) => console.error("[sweep] photo-folder check failed", err));
}
