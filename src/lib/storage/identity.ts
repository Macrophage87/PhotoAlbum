import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { liveImportKeys } from "@/lib/jobs/live";
import { IMPORT_ABANDONED_MS, IMPORT_NAME, PHOTO_FOLDER } from "./layout";

/**
 * Which album a storage root belongs to.
 *
 * Deciding that something under the root is orphaned means asking a database whether it knows about it, and a
 * database that is not this media's knows about none of it: a staging stack sharing the live /photos, a renamed
 * checkout that came up with an empty database over a bind-mounted media folder, a restore whose stack ran before
 * the dump went in, a staging database cloned from live (which carries live's id). So the install has an id, and the
 * database it was given to has a binding (its cluster's system identifier and its own name); both are kept in the
 * database (AppSetting) and in a marker file at the root, and nothing under the root is swept unless all agree.
 */
export const INSTALL_MARKER = ".album-install-id";

/** How much of the root's content the database must account for before it may claim a root with no marker. */
export const CLAIM_COVERAGE = 0.95;

export const UNKNOWN_FILES = "This storage holds files this album's database does not know.";

export type IdentityProblem = "unmarked" | "unknown-files" | "no-id" | "other-album" | "other-database";
export type InstallIdentity = { ok: true; id: string } | { ok: false; kind: IdentityProblem; problem: string };
type Marker = { installId: string; binding: string | null };

function markerPath(): string | null {
  return storage().localPath?.(INSTALL_MARKER) ?? null;
}

async function readMarker(): Promise<Marker | null> {
  const file = markerPath();
  const text = file ? (await readFile(file, "utf8").catch(() => null))?.trim() : null;
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<Marker>;
    return typeof m.installId === "string" && m.installId ? { installId: m.installId, binding: typeof m.binding === "string" ? m.binding : null } : null;
  } catch {
    // A bare id, as a person might write one: it names the album but no database.
    return { installId: text, binding: null };
  }
}

/** Written whole or not at all, so a crash never leaves half a marker. */
async function writeMarker(marker: Marker): Promise<void> {
  const file = markerPath()!;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker)}\n`);
  await rename(tmp, file);
}

/** The database this is, as the cluster knows it: a dump restored elsewhere, or a clone, answers differently. */
export async function databaseBinding(): Promise<string> {
  const rows = await db.$queryRaw<{ sys: string; name: string }[]>`SELECT system_identifier::text AS sys, current_database() AS name FROM pg_control_system()`.catch(async (err) => {
    console.error("[storage] could not read the cluster's system identifier; binding the install to the database name alone", err);
    return db.$queryRaw<{ sys: string; name: string }[]>`SELECT 'unknown' AS sys, current_database() AS name`;
  });
  return `${rows[0].sys}:${rows[0].name}`;
}

async function stored(): Promise<{ installId: string | null; installBinding: string | null }> {
  return (await db.appSetting.findUnique({ where: { id: "app" }, select: { installId: true, installBinding: true } })) ?? { installId: null, installBinding: null };
}

/** Whether the root already holds anything an album put there. */
async function rootHoldsMedia(): Promise<boolean> {
  for (const folder of ["photos", "imports"]) {
    const dir = storage().localPath?.(folder);
    if (dir && (await readdir(dir).catch(() => [] as string[])).length) return true;
  }
  return false;
}

export type Coverage = { ok: boolean; photoFolders: number; known: number; strayImports: number; problem: string | null };

/**
 * Whether this database accounts for what the root holds: a row for at least CLAIM_COVERAGE of the photo folders,
 * and every uploaded track file old enough to have been read either kept by a track or waited on by a live job. A
 * database with a handful of photos of its own facing another album's hundreds does not.
 */
export async function coverage(now = new Date()): Promise<Coverage> {
  const photos = storage().localPath?.("photos");
  const ids = photos ? (await readdir(photos, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && PHOTO_FOLDER.test(d.name)).map((d) => d.name) : [];
  let known = 0;
  for (let i = 0; i < ids.length; i += 500) known += await db.photo.count({ where: { id: { in: ids.slice(i, i + 500) } } });
  const imports = storage().localPath?.("imports");
  const names = imports ? (await readdir(imports).catch(() => [] as string[])).filter((n) => IMPORT_NAME.test(n)) : [];
  let strayImports = 0;
  let live: Set<string> | null | undefined;
  for (const name of names) {
    const s = await stat(path.join(imports!, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs >= now.getTime() - IMPORT_ABANDONED_MS) continue;
    const key = `imports/${name}`;
    if (await db.track.findFirst({ where: { originalFile: key }, select: { id: true } })) continue;
    if (live === undefined) live = await liveImportKeys();
    if (!live?.has(key)) strayImports++;
  }
  const photosOk = ids.length === 0 || known / ids.length >= CLAIM_COVERAGE;
  const ok = photosOk && strayImports === 0;
  const detail = [
    photosOk ? null : `${known} of ${ids.length} photo folders have a photo in this database`,
    strayImports ? `${strayImports} uploaded track file${strayImports === 1 ? " is" : "s are"} not this database's` : null,
  ].filter(Boolean);
  return { ok, photoFolders: ids.length, known, strayImports, problem: ok ? null : `${UNKNOWN_FILES} (${detail.join("; ")}.)` };
}

/** Give the database its id (keeping one it has), bind it to this database, and write the marker to match. */
async function bind(): Promise<string> {
  const binding = await databaseBinding();
  await db.$executeRaw`INSERT INTO "AppSetting" (id, "installId", "updatedAt") VALUES ('app', ${randomUUID()}, now()) ON CONFLICT (id) DO NOTHING`;
  await db.appSetting.updateMany({ where: { id: "app", installId: null }, data: { installId: randomUUID() } });
  await db.appSetting.update({ where: { id: "app" }, data: { installBinding: binding } });
  const { installId } = await stored();
  await writeMarker({ installId: installId!, binding });
  return installId!;
}

/**
 * At worker start. A root with no marker is claimed, id and binding, only when it is empty (a new install) or this
 * database accounts for what is in it (an album from before the marker). A marker that is present is never written
 * over here, whatever the database says: that is the admin's re-bind, with the same check.
 */
export async function ensureInstallIdentity(now = new Date()): Promise<InstallIdentity> {
  if (!markerPath()) return { ok: false, kind: "unmarked", problem: "This storage has no folder of its own to mark." };
  if (!(await readMarker())) {
    const cover = (await rootHoldsMedia()) ? await coverage(now) : null;
    if (cover && !cover.ok) {
      console.error(`[storage] ${cover.problem} Not marking it as this album's; nothing under it will be swept (docs/DEPLOY.md, "The install marker").`);
      return { ok: false, kind: "unknown-files", problem: cover.problem! };
    }
    await bind();
  }
  const identity = await installIdentity(now);
  if (!identity.ok) console.error(`[storage] ${identity.problem} Nothing under the storage root will be swept until this is put right (docs/DEPLOY.md, "The install marker").`);
  return identity;
}

/**
 * The admin's answer to a notice after a genuine move or restore: make this database the storage's owner. Refused
 * unless the database accounts for what the root holds, the same test a root with no marker has to pass.
 */
export async function rebindInstall(now = new Date()): Promise<{ ok: boolean; message: string }> {
  if (!markerPath()) return { ok: false, message: "This storage has no folder of its own to mark." };
  if ((await installIdentity(now)).ok) return { ok: true, message: "The storage is already this database's." };
  const cover = await coverage(now);
  if (!cover.ok) return { ok: false, message: `Not re-bound. ${cover.problem}` };
  const id = await bind();
  console.warn(`[storage] storage root re-bound to this database (install ${id}) by an admin`);
  return { ok: true, message: `The storage is now this database's (${cover.known} of ${cover.photoFolders} photo folders have a photo here).` };
}

/** Whether this database and this storage root are the same album's. Every sweep, and the quarantine, asks first. */
export async function installIdentity(now = new Date()): Promise<InstallIdentity> {
  const [marker, mine, binding] = await Promise.all([readMarker(), stored(), databaseBinding()]);
  if (!marker) {
    // Said as the worker would say it at start, so the notice tells an admin whether a re-bind can help.
    if (await rootHoldsMedia()) {
      const cover = await coverage(now);
      if (!cover.ok) return { ok: false, kind: "unknown-files", problem: cover.problem! };
    }
    return { ok: false, kind: "unmarked", problem: `The storage root has no ${INSTALL_MARKER} file, so it cannot be told apart from another album's media.` };
  }
  if (!mine.installId) return { ok: false, kind: "no-id", problem: `The storage root belongs to an album (its ${INSTALL_MARKER} says so), but this database has no install id: it may be empty, or restored from before the marker.` };
  if (marker.installId !== mine.installId) return { ok: false, kind: "other-album", problem: `The storage root's ${INSTALL_MARKER} is another album's, not this database's. Two albums may be sharing one media folder.` };
  if (mine.installBinding !== binding || marker.binding !== binding) {
    return { ok: false, kind: "other-database", problem: "This is the album the storage belongs to, but not the database it was bound to: a copy of that database (a staging clone), or the same album restored or moved to another server." };
  }
  return { ok: true, id: mine.installId };
}
