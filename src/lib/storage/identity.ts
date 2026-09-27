import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { liveImportKeys } from "@/lib/jobs/live";
import { IMPORT_ABANDONED_MS, IMPORT_NAME, newestWrite, PHOTO_FOLDER } from "./layout";

/**
 * Which album a storage root belongs to.
 *
 * Deciding that something under the root is orphaned means asking a database whether it knows about it, and a
 * database that is not this media's knows about none of it: a staging stack sharing the live /photos, a renamed
 * checkout that came up with an empty database over a bind-mounted media folder, a restore whose stack ran before
 * the dump went in, a staging database cloned from live (which carries live's id). So the install has an id, and the
 * database it was given to has a binding (its cluster's system identifier and its own name); both are kept in the
 * database (AppSetting) and in a marker file at the root, and nothing under the root is swept unless all agree.
 *
 * The worker bound to the root also writes a heartbeat into the marker, at start and every hour. While it is fresh,
 * no other database may re-bind the root: a clone passes every other test (its rows are live's), so only "another
 * database is still using this" can tell it from a genuine move.
 *
 * Only an empty root is marked by itself. One that already holds media (an album from before the marker) waits for
 * an admin to claim it, and a claim is refused while files this database does not know are still arriving: live on
 * code from before the marker writes no heartbeat, but it does keep adding photos and track files.
 */
export const INSTALL_MARKER = ".album-install-id";

/** How much of the root's content the database must account for before it may claim or re-bind it. */
export const CLAIM_COVERAGE = 0.95;
/** How long after another database's last heartbeat, or last file this one does not know, the root may be claimed. */
export const HEARTBEAT_STALE_MS = 48 * 3600_000;
/** How long an Admin page reuses a coverage count rather than walking the root again. */
const COVERAGE_CACHE_MS = 10 * 60_000;

export const UNKNOWN_FILES = "This storage holds files this album's database does not know.";

export type IdentityProblem = "unmarked" | "unclaimed" | "unknown-files" | "no-id" | "other-album" | "other-database" | "cannot-verify-database";
export type InstallIdentity = { ok: true; id: string } | { ok: false; kind: IdentityProblem; problem: string };
/** `heartbeatAt` is kept as found: one that is there but unreadable must not pass for none. */
type Marker = { installId: string; binding: string | null; heartbeatBinding?: unknown; heartbeatAt?: unknown };

function markerPath(): string | null {
  return storage().localPath?.(INSTALL_MARKER) ?? null;
}

async function readMarker(): Promise<Marker | null> {
  const file = markerPath();
  const text = file ? (await readFile(file, "utf8").catch(() => null))?.trim() : null;
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<Marker> & { installId?: unknown; binding?: unknown };
    if (typeof m.installId !== "string" || !m.installId) return null;
    const heartbeat = "heartbeatAt" in m || "heartbeatBinding" in m ? { heartbeatAt: m.heartbeatAt, heartbeatBinding: m.heartbeatBinding } : {};
    return { installId: m.installId, binding: typeof m.binding === "string" ? m.binding : null, ...heartbeat };
  } catch {
    // A bare id, as a person might write one: it names the album but no database.
    return { installId: text, binding: null };
  }
}

/** Written whole or not at all, so a crash never leaves half a marker. */
async function writeMarker(marker: Marker): Promise<void> {
  const file = markerPath()!;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker)}\n`);
  await rename(tmp, file);
}

let bindingUnreadableLogged = false;

/**
 * The database this is, as the cluster knows it: a dump restored elsewhere, or a clone, answers differently. Null
 * when the cluster will not say (pg_control_system() not granted), and then nothing is swept: the database name
 * alone would let a clone in another cluster pass for this one.
 */
export async function databaseBinding(): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ sys: string; name: string }[]>`SELECT system_identifier::text AS sys, current_database() AS name FROM pg_control_system()`;
    return rows[0]?.sys ? `${rows[0].sys}:${rows[0].name}` : null;
  } catch (err) {
    if (!bindingUnreadableLogged) console.error("[storage] cannot read the cluster's system identifier (pg_control_system()); nothing under the storage root will be swept", err);
    bindingUnreadableLogged = true;
    return null;
  }
}

async function cannotVerify(): Promise<{ ok: false; kind: IdentityProblem; problem: string }> {
  const who = await db.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`.then((r) => r[0]?.user ?? "<user>", () => "<user>");
  return { ok: false, kind: "cannot-verify-database", problem: `The album cannot read this database's system identifier, so it cannot tell it from a copy. As the database's owner, run: GRANT EXECUTE ON FUNCTION pg_control_system() TO ${who};` };
}

async function stored(): Promise<{ installId: string | null; installBinding: string | null }> {
  return (await db.appSetting.findUnique({ where: { id: "app" }, select: { installId: true, installBinding: true } })) ?? { installId: null, installBinding: null };
}

/** The photo folders (named as the album names them) under the root. */
async function photoFolders(): Promise<string[]> {
  const photos = storage().localPath?.("photos");
  return photos ? (await readdir(photos, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && PHOTO_FOLDER.test(d.name)).map((d) => d.name) : [];
}

/** The uploaded track files (named as the import route names them) under the root. */
async function importFiles(): Promise<string[]> {
  const dir = storage().localPath?.("imports");
  return dir ? (await readdir(dir).catch(() => [] as string[])).filter((n) => IMPORT_NAME.test(n)) : [];
}

/** Whether the root holds nothing an album put there: the only kind of root that is marked without an admin. */
async function rootIsEmpty(): Promise<boolean> {
  return !(await photoFolders()).length && !(await importFiles()).length;
}

/** An import file this database has a reason to keep: a track made from it, or a job that will read it. */
async function knownImport(key: string, live: { keys?: Set<string> | null }): Promise<boolean> {
  if (await db.track.findFirst({ where: { originalFile: key }, select: { id: true } })) return true;
  if (live.keys === undefined) live.keys = await liveImportKeys();
  return Boolean(live.keys?.has(key));
}

/**
 * How long ago a file this database does not know was last written under the root, when that is within
 * HEARTBEAT_STALE_MS: a photo folder with no row here, or an uploaded track file no track or job of this database
 * refers to. Another album (live, still on code that writes no heartbeat) is then still using the root.
 */
export async function recentUnknownWrite(now = new Date()): Promise<number | null> {
  const since = now.getTime() - HEARTBEAT_STALE_MS;
  let latest = -Infinity;
  const ids = await photoFolders();
  const dir = storage().localPath!("photos");
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = new Set((await db.photo.findMany({ where: { id: { in: batch } }, select: { id: true } })).map((r) => r.id));
    for (const id of batch) if (!rows.has(id)) latest = Math.max(latest, await newestWrite(path.join(dir, id)));
  }
  const imports = storage().localPath!("imports");
  const live: { keys?: Set<string> | null } = {};
  for (const name of await importFiles()) {
    const s = await stat(path.join(imports, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs < since || (await knownImport(`imports/${name}`, live))) continue;
    latest = Math.max(latest, s.mtimeMs);
  }
  return latest >= since ? Math.max(0, Math.round((now.getTime() - latest) / 60_000)) : null;
}

export type Coverage = { ok: boolean; photoFolders: number; known: number; imports: number; knownImports: number; problem: string | null };
let lastCoverage: { at: number; result: Coverage } | null = null;

/**
 * Whether this database accounts for what the root holds: a row for at least CLAIM_COVERAGE of the photo folders. A
 * database with a handful of photos of its own facing another album's hundreds does not. Uploaded track files count
 * only for an album with no photo folders at all: older albums kept failed uploads there for good, and one of those
 * must not keep a healthy album from ever being marked (the sweep clears them once it is).
 */
export async function coverage(now = new Date()): Promise<Coverage> {
  const ids = await photoFolders();
  let known = 0;
  for (let i = 0; i < ids.length; i += 500) known += await db.photo.count({ where: { id: { in: ids.slice(i, i + 500) } } });
  let imports = 0, knownImports = 0;
  if (!ids.length) {
    const dir = storage().localPath!("imports");
    const live: { keys?: Set<string> | null } = {};
    for (const name of await importFiles()) {
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (!s?.isFile() || s.mtimeMs >= now.getTime() - IMPORT_ABANDONED_MS) continue;
      imports++;
      if (await knownImport(`imports/${name}`, live)) knownImports++;
    }
  }
  const ok = ids.length ? known / ids.length >= CLAIM_COVERAGE : !imports || knownImports / imports >= CLAIM_COVERAGE;
  const detail = ids.length ? `${known} of ${ids.length} photo folders have a photo in this database` : `${knownImports} of ${imports} uploaded track files belong to this database`;
  const result = { ok, photoFolders: ids.length, known, imports, knownImports, problem: ok ? null : `${UNKNOWN_FILES} (${detail}.)` };
  lastCoverage = { at: now.getTime(), result };
  return result;
}

/** Drop the remembered coverage count, so the next report walks the root again. */
export function forgetCoverage(): void {
  lastCoverage = null;
}

/** The last coverage count when it is recent, for pages that only report it. */
async function recentCoverage(now: Date): Promise<Coverage> {
  const age = lastCoverage ? now.getTime() - lastCoverage.at : Infinity;
  return lastCoverage && age >= 0 && age < COVERAGE_CACHE_MS ? lastCoverage.result : coverage(now);
}

/** Give the database its id (keeping one it has), bind it to this database, and write the marker to match. */
async function bind(binding: string, now: Date): Promise<string> {
  await db.$executeRaw`INSERT INTO "AppSetting" (id, "installId", "updatedAt") VALUES ('app', ${randomUUID()}, now()) ON CONFLICT (id) DO NOTHING`;
  await db.appSetting.updateMany({ where: { id: "app", installId: null }, data: { installId: randomUUID() } });
  await db.appSetting.update({ where: { id: "app" }, data: { installBinding: binding } });
  const { installId } = await stored();
  await writeMarker({ installId: installId!, binding, heartbeatBinding: binding, heartbeatAt: now.toISOString() });
  return installId!;
}

/**
 * The worker's word that this database is still using the root: at start and every hour, and only while the two
 * agree. Another database may re-bind the root only once this is HEARTBEAT_STALE_MS old.
 */
export async function touchHeartbeat(now = new Date()): Promise<boolean> {
  if (!(await installIdentity(now)).ok) return false;
  const marker = (await readMarker())!;
  await writeMarker({ ...marker, heartbeatBinding: marker.binding!, heartbeatAt: now.toISOString() });
  return true;
}

/**
 * At worker start. A root with no marker is marked, id and binding, only when it is empty (a new install). One that
 * already holds media waits for an admin's claim (rebindInstall), however much of it this database seems to know: a
 * staging clone of live's database knows all of live's. A marker that is present is never written over here.
 */
export async function ensureInstallIdentity(now = new Date()): Promise<InstallIdentity> {
  if (!markerPath()) return { ok: false, kind: "unmarked", problem: "This storage has no folder of its own to mark." };
  const binding = await databaseBinding();
  if (!binding) return cannotVerify();
  if (!(await readMarker()) && (await rootIsEmpty())) await bind(binding, now);
  const identity = await installIdentity(now);
  if (identity.ok) await touchHeartbeat(now);
  else console.error(`[storage] ${identity.problem} Nothing under the storage root will be swept until this is put right (docs/DEPLOY.md, "The install marker").`);
  return identity;
}

export type RebindBlock = { lastUsed: Date; minutesAgo: number; until: Date } | { unreadable: true };

/**
 * When another database last said it was using the root, and until when that keeps this one from claiming it. A
 * heartbeat that is there but cannot be read blocks too: only a marker without one says nobody else is using it.
 */
export async function rebindBlockedUntil(now = new Date()): Promise<RebindBlock | null> {
  const [marker, binding] = await Promise.all([readMarker(), databaseBinding()]);
  if (!marker || !binding || (!("heartbeatAt" in marker) && !("heartbeatBinding" in marker))) return null;
  const at = typeof marker.heartbeatAt === "string" ? Date.parse(marker.heartbeatAt) : NaN;
  if (typeof marker.heartbeatBinding !== "string" || !Number.isFinite(at)) return { unreadable: true };
  if (marker.heartbeatBinding === binding) return null;
  const until = new Date(at + HEARTBEAT_STALE_MS);
  return until.getTime() > now.getTime() ? { lastUsed: new Date(at), minutesAgo: Math.max(0, Math.round((now.getTime() - at) / 60_000)), until } : null;
}

export const utcStamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * The admin's claim of a root that holds media, or re-bind of one after a genuine move or restore: make this
 * database the storage's owner. Refused while another database's worker has used the root within
 * HEARTBEAT_STALE_MS, or files this database does not know were written there within it (it may be live, and this
 * a clone of it), and unless the database accounts for what the root holds.
 */
export async function rebindInstall(now = new Date()): Promise<{ ok: boolean; message: string }> {
  if (!markerPath()) return { ok: false, message: "This storage has no folder of its own to mark." };
  const claiming = !(await readMarker());
  const not = claiming ? "Not claimed." : "Not re-bound.";
  const binding = await databaseBinding();
  if (!binding) return { ok: false, message: `${not} ${(await cannotVerify()).problem}` };
  if ((await installIdentity(now)).ok) return { ok: true, message: "The storage is already this database's." };
  const blocked = await rebindBlockedUntil(now);
  if (blocked && "unreadable" in blocked) return { ok: false, message: `${not} The storage's ${INSTALL_MARKER} has a heartbeat that cannot be read, so another album may still be using it. Stop any other site that shares this folder; see "The install marker" in the deployment guide.` };
  if (blocked) return { ok: false, message: `${not} Another database used this storage ${minutesWord(blocked.minutesAgo)} ago; stop that album first, then wait until ${utcStamp(blocked.until)}.` };
  const unknown = await recentUnknownWrite(now);
  if (unknown !== null) return { ok: false, message: `${not} Files were added here ${minutesWord(unknown)} ago that this database doesn't know. Another album is still using this storage; stop it first.` };
  const cover = await coverage(now);
  if (!cover.ok) return { ok: false, message: `${not} ${cover.problem}` };
  const id = await bind(binding, now);
  const verb = claiming ? "claimed" : "re-bound";
  console.warn(`[storage] storage root ${verb} for this database (install ${id}) by an admin`);
  return { ok: true, message: cover.photoFolders ? `The storage is ${verb}: it is now this database's (${cover.known} of ${cover.photoFolders} photo folders have a photo here).` : `The storage is ${verb}: it is now this database's.` };
}

/** Whether this database and this storage root are the same album's. Every sweep, and the quarantine, asks first. */
export async function installIdentity(now = new Date()): Promise<InstallIdentity> {
  const [marker, mine, binding] = await Promise.all([readMarker(), stored(), databaseBinding()]);
  if (!binding) return cannotVerify();
  if (!marker) {
    if (await rootIsEmpty()) return { ok: false, kind: "unmarked", problem: `The storage root has no ${INSTALL_MARKER} file yet; the worker writes one when it starts.` };
    // Said so the notice tells an admin whether a claim can help.
    const cover = await recentCoverage(now);
    if (!cover.ok) return { ok: false, kind: "unknown-files", problem: cover.problem! };
    return { ok: false, kind: "unclaimed", problem: `This storage holds this album's photos but has not been claimed by it yet (it has no ${INSTALL_MARKER}).` };
  }
  if (!mine.installId) return { ok: false, kind: "no-id", problem: `The storage root belongs to an album (its ${INSTALL_MARKER} says so), but this database has no install id: it may be empty, or restored from before the marker.` };
  if (marker.installId !== mine.installId) return { ok: false, kind: "other-album", problem: `The storage root's ${INSTALL_MARKER} is another album's, not this database's. Two albums may be sharing one media folder.` };
  if (mine.installBinding !== binding || marker.binding !== binding) {
    return { ok: false, kind: "other-database", problem: "This is the album the storage belongs to, but not the database it is bound to." };
  }
  return { ok: true, id: mine.installId };
}
