import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

/**
 * Which album a storage root belongs to.
 *
 * Deciding that something under the root is orphaned means asking a database whether it knows about it, and a
 * database that is not this media's knows about none of it: a staging stack sharing the live /photos, a renamed
 * checkout that came up with an empty database over a bind-mounted media folder, a restore whose stack ran before
 * the dump went in. So the install has an id, kept both in the database (AppSetting.installId) and in a marker file
 * at the root, and nothing under the root is swept unless the two agree.
 */
export const INSTALL_MARKER = ".album-install-id";

export type InstallIdentity = { ok: true; id: string } | { ok: false; problem: string };

function markerPath(): string | null {
  return storage().localPath?.(INSTALL_MARKER) ?? null;
}

async function readMarker(): Promise<string | null> {
  const file = markerPath();
  if (!file) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  return text?.trim() || null;
}

async function databaseId(): Promise<string | null> {
  return (await db.appSetting.findUnique({ where: { id: "app" }, select: { installId: true } }))?.installId ?? null;
}

/** Whether the root already holds anything an album put there. */
async function rootHoldsMedia(): Promise<boolean> {
  for (const folder of ["photos", "imports"]) {
    const dir = storage().localPath?.(folder);
    if (dir && (await readdir(dir).catch(() => [] as string[])).length) return true;
  }
  return false;
}

/**
 * At worker start. The first time, the install is given its id and the root its marker. A root with no marker is
 * marked only when this database has photos (an album from before the marker) or the root holds nothing yet (a new
 * install): an empty database is never taken as the owner of media that is already there. A marker that is present
 * is never written over, whatever the database says.
 */
export async function ensureInstallIdentity(): Promise<InstallIdentity> {
  const file = markerPath();
  if (!file) return { ok: false, problem: "This storage has no folder of its own to mark." };
  if (!(await readMarker())) {
    const hasPhotos = Boolean(await db.photo.findFirst({ select: { id: true } }));
    if (hasPhotos || !(await rootHoldsMedia())) {
      await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", installId: randomUUID() }, update: {} });
      await db.appSetting.updateMany({ where: { id: "app", installId: null }, data: { installId: randomUUID() } });
      const id = await databaseId();
      // "wx": never over a marker another process wrote meanwhile.
      if (id) await writeFile(file, `${id}\n`, { flag: "wx" }).catch((err) => { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; });
    }
  }
  const identity = await installIdentity();
  if (!identity.ok) console.error(`[storage] ${identity.problem} Nothing under the storage root will be swept until this is put right (docs/DEPLOY.md, "The install marker").`);
  return identity;
}

/** Whether this database and this storage root are the same album's. Every sweep, and the quarantine, asks first. */
export async function installIdentity(): Promise<InstallIdentity> {
  const [marker, id] = await Promise.all([readMarker(), databaseId()]);
  if (!marker) return { ok: false, problem: `The storage root has no ${INSTALL_MARKER} file, so it cannot be told apart from another album's media.` };
  if (!id) return { ok: false, problem: `The storage root belongs to an album (its ${INSTALL_MARKER} says so), but this database has no install id: it may be empty, or restored from before the marker.` };
  if (marker !== id) return { ok: false, problem: `The storage root's ${INSTALL_MARKER} is another album's, not this database's. Two albums may be sharing one media folder.` };
  return { ok: true, id };
}
