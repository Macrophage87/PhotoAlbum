import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** Files that work which died part-way left behind: uploaded track files no import will read again, and photo folders. */
const root = mkdtempSync(path.join(tmpdir(), "storage-sweep-"));
const inbox = mkdtempSync(path.join(tmpdir(), "storage-sweep-inbox-"));
process.env.PHOTO_STORAGE_ROOT = root;
process.env.IMPORT_INBOX_DIR = inbox;
const jobs = vi.hoisted(() => ({ importKeys: new Set<string>() as Set<string> | null }));
// No pg-boss here: what its live import jobs would read is given by each test.
vi.mock("@/lib/jobs/live", () => ({ liveImportKeys: async () => jobs.importKeys }));

import { IMPORT_ABANDONED_MS, ORPHAN_FOLDER_MS, QUARANTINE_KEEP_MS, QUARANTINE_MANIFEST, emptyQuarantine, findOrphanPhotoFolders, quarantineOrphanPhotoFolders, recordOrphanPhotoFolders, sweepImportFiles } from "@/lib/storage/sweep";
import { databaseBinding, ensureInstallIdentity, INSTALL_MARKER, installIdentity, rebindInstall } from "@/lib/storage/identity";

const now = new Date("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
/** A file under the storage root, last written `ageMs` before `now`. */
function file(key: string, ageMs: number): string {
  const full = path.join(root, key);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "x");
  const t = new Date(now.getTime() - ageMs);
  utimesSync(full, t, t);
  return full;
}
let n = 0;
/** A name shaped like the ones the import route gives what it stores. */
const uuidName = (ext = "json") => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}.${ext}`;
/** A cuid, as the album names a row and its folder. */
const cuid = () => `cabcdefghijkl${String(++n).padStart(12, "0")}`;
const marker = () => path.join(root, INSTALL_MARKER);

/** Wipe the storage root and the database, then give this album its identity as the worker does at start. */
async function freshInstall() {
  await resetTestDb();
  for (const entry of readdirSync(root)) rmSync(path.join(root, entry), { recursive: true, force: true });
  jobs.importKeys = new Set();
  expect((await ensureInstallIdentity()).ok).toBe(true);
}

describe("the install marker", { timeout: 30_000 }, () => {
  beforeEach(freshInstall);

  it("is written once, on a new install, and names the album and the database", async () => {
    const written = JSON.parse(readFileSync(marker(), "utf8")) as { installId: string; binding: string };
    expect(written.binding).toBe(await databaseBinding());
    expect(await installIdentity()).toEqual({ ok: true, id: written.installId });
    expect(await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).toMatchObject({ installId: written.installId, installBinding: written.binding });
    // Starting again changes nothing.
    await ensureInstallIdentity();
    expect(readFileSync(marker(), "utf8")).toBe(`${JSON.stringify(written)}\n`);
  });

  it("is not claimed by an empty database facing media that is already there", async () => {
    rmSync(marker());
    await db.appSetting.deleteMany();
    file(`photos/${cuid()}/original.jpg`, DAY);
    expect(await ensureInstallIdentity()).toMatchObject({ ok: false, kind: "unknown-files", problem: expect.stringContaining("This storage holds files this album's database does not know.") });
    expect(existsSync(marker())).toBe(false);
  });

  it("is not claimed by another album's database that happens to have photos of its own", async () => {
    // Live, on code from before the marker: sixty photos and a GPX file kept with its track, and no marker.
    const live = Array.from({ length: 60 }, () => cuid());
    for (const id of live) file(`photos/${id}/original.jpg`, 30 * DAY);
    const gpx = file(`imports/${uuidName("gpx")}`, 30 * DAY);
    // Staging, with its own database of one photo, starts first against the same root.
    rmSync(marker());
    await db.appSetting.deleteMany();
    const uploaderId = (await db.user.create({ data: { email: "staging@example.com" } })).id;
    const own = cuid();
    await db.photo.create({ data: { id: own, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${own}`, originalPath: `photos/${own}/original.jpg`, sizeBytes: 1, status: "READY" } });
    const r = await ensureInstallIdentity(now);
    expect(r).toMatchObject({ ok: false, kind: "unknown-files" });
    expect(existsSync(marker())).toBe(false);
    // Its hourly sweep leaves live's file alone, and its admin cannot re-bind the root to it either.
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(gpx)).toBe(true);
    expect(await rebindInstall(now)).toMatchObject({ ok: false, message: expect.stringMatching(/does not know/) });
    expect(existsSync(marker())).toBe(false);
  });

  it("is claimed for an album from before the marker only when the database accounts for the files", async () => {
    const uploaderId = (await db.user.create({ data: { email: "old@example.com" } })).id;
    const ids = Array.from({ length: 20 }, () => cuid());
    for (const id of ids) file(`photos/${id}/original.jpg`, 30 * DAY);
    const addRows = (list: string[]) => db.photo.createMany({ data: list.map((id) => ({ id, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${id}`, originalPath: `photos/${id}/original.jpg`, sizeBytes: 1, status: "READY" as const })) });
    rmSync(marker());
    await db.appSetting.deleteMany();
    // Eighteen of twenty is under 95%.
    await addRows(ids.slice(0, 18));
    expect((await ensureInstallIdentity(now)).ok).toBe(false);
    // An uploaded track file nothing refers to is not this database's either.
    await addRows(ids.slice(18, 19));
    const stray = file(`imports/${uuidName("gpx")}`, 30 * DAY);
    expect(await ensureInstallIdentity(now)).toMatchObject({ ok: false, kind: "unknown-files", problem: expect.stringMatching(/1 uploaded track file is not/) });
    rmSync(stray);
    expect((await ensureInstallIdentity(now)).ok).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });

  it("is written for an album from before the marker, whose database has its photos", async () => {
    rmSync(marker());
    await db.appSetting.deleteMany();
    const uploaderId = (await db.user.create({ data: { email: "old@example.com" } })).id;
    const id = cuid();
    await db.photo.create({ data: { id, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${id}`, originalPath: `photos/${id}/original.jpg`, sizeBytes: 1, status: "READY" } });
    file(`photos/${id}/original.jpg`, DAY);
    expect((await ensureInstallIdentity()).ok).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });

  it("refuses a copy of this database, and lets an admin re-bind after a genuine move once the files are accounted for", async () => {
    const written = JSON.parse(readFileSync(marker(), "utf8")) as { installId: string; binding: string };
    // A staging database cloned from live: live's id and live's binding, in a database that is neither.
    await db.appSetting.update({ where: { id: "app" }, data: { installBinding: "7000000000000000001:photoalbum" } });
    writeFileSync(marker(), JSON.stringify({ installId: written.installId, binding: "7000000000000000001:photoalbum" }));
    const stale = file(`imports/${uuidName()}`, 2 * IMPORT_ABANDONED_MS);
    expect(await installIdentity()).toMatchObject({ ok: false, kind: "other-database" });
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(stale)).toBe(true);
    // The album restored on another server: its own id, and a database that accounts for the files (here, none but a
    // stray track file, which it does not). Refused until that is so, then re-bound.
    expect(await rebindInstall(now)).toMatchObject({ ok: false });
    rmSync(stale);
    expect(await rebindInstall(now)).toMatchObject({ ok: true });
    expect(await installIdentity()).toEqual({ ok: true, id: written.installId });
    expect(JSON.parse(readFileSync(marker(), "utf8"))).toEqual({ installId: written.installId, binding: await databaseBinding() });
  });

  it("takes a bare id in the marker for the album, but not for this database", async () => {
    const written = JSON.parse(readFileSync(marker(), "utf8")) as { installId: string };
    writeFileSync(marker(), `${written.installId}\n`);
    expect(await installIdentity()).toMatchObject({ ok: false, kind: "other-database" });
  });

  it("refuses another album's database, and an empty one, against a marked root", async () => {
    await db.appSetting.update({ where: { id: "app" }, data: { installId: "someone-else" } });
    expect(await installIdentity()).toMatchObject({ ok: false, problem: expect.stringMatching(/another album/) });
    await db.appSetting.deleteMany();
    expect(await installIdentity()).toMatchObject({ ok: false, problem: expect.stringMatching(/no install id/) });
    // Nor does starting up take the root over.
    await ensureInstallIdentity();
    expect((await installIdentity()).ok).toBe(false);
  });
});

describe("the sweep of uploaded track files", () => {
  beforeEach(freshInstall);

  it("deletes one a crashed import left behind, once it is a few hours old", async () => {
    const stale = file(`imports/${uuidName()}`, IMPORT_ABANDONED_MS + 60_000);
    const fresh = file(`imports/${uuidName()}`, IMPORT_ABANDONED_MS - 60_000);
    expect(await sweepImportFiles(now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps one a live job will still read, and one a track was made from", async () => {
    const queuedName = uuidName(), keptName = uuidName("gpx");
    const queued = file(`imports/${queuedName}`, 2 * IMPORT_ABANDONED_MS);
    const kept = file(`imports/${keptName}`, 2 * IMPORT_ABANDONED_MS);
    jobs.importKeys = new Set([`imports/${queuedName}`]);
    const user = await db.user.create({ data: { email: "t@example.com" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: now, endDate: now, createdById: user.id } });
    await db.track.create({ data: { tripId: trip.id, uploaderId: user.id, source: "GPX", name: "Walk", originalFile: `imports/${keptName}`, startTime: now, endTime: now, pointCount: 0, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array() } });
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(kept)).toBe(true);
  });

  it("leaves alone anything not named the way the import route names files", async () => {
    const others = ["imports/takeout-2025.zip", "imports/notes.txt", "imports/0000.json"].map((k) => file(k, 30 * DAY));
    expect(await sweepImportFiles(now)).toBe(0);
    for (const f of others) expect(existsSync(f)).toBe(true);
  });

  it("deletes nothing when it cannot tell which files the queue still needs", async () => {
    const stale = file(`imports/${uuidName()}`, 2 * IMPORT_ABANDONED_MS);
    jobs.importKeys = null;
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it("deletes nothing when the database is not this storage's", async () => {
    const stale = file(`imports/${uuidName()}`, 2 * IMPORT_ABANDONED_MS);
    await db.appSetting.deleteMany();
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it("never sweeps the Takeout inbox, even when it is the same folder", async () => {
    vi.resetModules();
    process.env.IMPORT_INBOX_DIR = path.join(root, "imports");
    try {
      const { sweepImportFiles: sweep } = await import("@/lib/storage/sweep");
      const archive = file(`imports/${uuidName("zip")}`, 30 * DAY);
      expect(await sweep(now)).toBe(0);
      expect(existsSync(archive)).toBe(true);
    } finally {
      process.env.IMPORT_INBOX_DIR = inbox;
      vi.resetModules();
    }
  });
});

// Tens of folders and rows each, which a loaded machine can take a while over.
describe("photo folders with no photo", { timeout: 30_000 }, () => {
  let uploaderId: string;
  beforeEach(async () => {
    await freshInstall();
    uploaderId = (await db.user.create({ data: { email: "u@example.com" } })).id;
  });
  const row = (id: string) => db.photo.create({ data: { id, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${id}`, originalPath: `photos/${id}/original.jpg`, sizeBytes: 1, status: "READY" } });
  /** A photo's folder, with a file in a subfolder, everything in it last written `ageMs` before `now`. */
  const folder = (id: string, ageMs: number) => {
    for (const name of ["original.jpg", "thumb.webp", "frames/1.jpg"]) file(`photos/${id}/${name}`, ageMs);
    const t = new Date(now.getTime() - ageMs);
    utimesSync(path.join(root, "photos", id, "frames"), t, t);
    utimesSync(path.join(root, "photos", id), t, t);
    return path.join(root, "photos", id);
  };
  /** An album of `rows` photos with a folder each, plus `orphans` folders with no row, all a month old. */
  async function album(rows: number, orphans: number) {
    const kept = Array.from({ length: rows }, () => cuid()), lost = Array.from({ length: orphans }, () => cuid());
    await db.photo.createMany({ data: kept.map((id) => ({ id, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${id}`, originalPath: `photos/${id}/original.jpg`, sizeBytes: 1, status: "READY" as const })) });
    for (const id of [...kept, ...lost]) folder(id, 30 * DAY);
    return { kept, lost };
  }
  const present = (ids: string[]) => ids.filter((id) => existsSync(path.join(root, "photos", id))).length;

  it("are found and counted by the hourly check, and nothing is moved or deleted", async () => {
    const { kept, lost } = await album(40, 1);
    const recent = cuid();
    folder(recent, 30 * DAY);
    // Written to an hour ago, deep inside: not abandoned.
    file(`photos/${recent}/frames/2.jpg`, 3600_000);
    // Not a name the album makes.
    mkdirSync(path.join(root, "photos", "perf"), { recursive: true });
    utimesSync(path.join(root, "photos", "perf"), new Date(0), new Date(0));
    expect(await recordOrphanPhotoFolders(now)).toBe(1);
    expect(await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).toMatchObject({ orphanFolderCount: 1, orphanFolderSample: lost });
    expect(present([...kept, ...lost, recent, "perf"])).toBe(43);
  });

  it("deletes nothing and moves nothing when the database is empty, or another album's", async () => {
    const { kept } = await album(30, 0);
    const { installId: own, installBinding } = await db.appSetting.findUniqueOrThrow({ where: { id: "app" } });
    // The dangerous one: an empty database facing a full media folder, as after a restore that has not run yet.
    await db.photo.deleteMany();
    for (const state of ["empty", "other"] as const) {
      if (state === "empty") await db.appSetting.deleteMany();
      else await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", installId: "another-album" }, update: { installId: "another-album" } });
      expect((await installIdentity()).ok).toBe(false);
      expect(await findOrphanPhotoFolders(now)).toMatchObject({ ok: false });
      expect(await recordOrphanPhotoFolders(now)).toBeNull();
      expect(await quarantineOrphanPhotoFolders(30, now)).toMatchObject({ ok: false });
      expect(await emptyQuarantine(now)).toMatchObject({ ok: false });
    }
    // Even with the right identity, an album with no photos at all moves nothing.
    await db.appSetting.update({ where: { id: "app" }, data: { installId: own, installBinding } });
    expect(await quarantineOrphanPhotoFolders(30, now)).toMatchObject({ ok: false, message: expect.stringMatching(/no photos at all/) });
    expect(present(kept)).toBe(30);
    expect(existsSync(path.join(root, "quarantine"))).toBe(false);
  });

  it("refuses to move more than a small share of the folders at once", async () => {
    const { kept, lost } = await album(20, 2);
    // Two of twenty-two is over five percent.
    expect(await quarantineOrphanPhotoFolders(2, now)).toMatchObject({ ok: false, message: expect.stringMatching(/more than one move may take/) });
    expect(present([...kept, ...lost])).toBe(22);
  });

  it("refuses when the typed count is not what it finds now", async () => {
    const { lost } = await album(40, 1);
    expect(await quarantineOrphanPhotoFolders(2, now)).toMatchObject({ ok: false });
    expect(present(lost)).toBe(1);
  });

  it("moves them to the quarantine, and emptying it deletes only what has been there over thirty days", async () => {
    const { kept, lost } = await album(40, 1);
    expect(await quarantineOrphanPhotoFolders(1, now)).toMatchObject({ ok: true, moved: 1 });
    expect(present(kept)).toBe(40);
    expect(present(lost)).toBe(0);
    const todayDir = path.join(root, "quarantine", now.toISOString().slice(0, 10));
    const today = path.join(todayDir, lost[0]);
    expect(existsSync(path.join(today, "frames/1.jpg"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(todayDir, QUARANTINE_MANIFEST), "utf8"))).toEqual({ [lost[0]]: now.toISOString() });
    expect(await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).toMatchObject({ orphanFolderCount: 0 });
    // An earlier move, recorded long enough ago to go; and in the same old-dated folder, one with no record of when
    // it came (copied in by hand, say), which stays.
    const oldDir = path.join(root, "quarantine", new Date(now.getTime() - QUARANTINE_KEEP_MS - DAY).toISOString().slice(0, 10));
    const old = path.join(oldDir, cuid()), unrecorded = path.join(oldDir, cuid());
    mkdirSync(old, { recursive: true });
    mkdirSync(unrecorded, { recursive: true });
    writeFileSync(path.join(oldDir, QUARANTINE_MANIFEST), JSON.stringify({ [path.basename(old)]: new Date(now.getTime() - QUARANTINE_KEEP_MS - DAY).toISOString() }));
    expect(await emptyQuarantine(now)).toMatchObject({ ok: true, moved: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(unrecorded)).toBe(true);
    expect(existsSync(today)).toBe(true);
    // A month on, today's goes too.
    expect(await emptyQuarantine(new Date(now.getTime() + QUARANTINE_KEEP_MS + DAY))).toMatchObject({ ok: true, moved: 1 });
    expect(existsSync(today)).toBe(false);
  });

  it("goes by when a folder was moved, not the name of the day it sits under", async () => {
    const dir = path.join(root, "quarantine", "2020-01-01");
    const id = cuid();
    mkdirSync(path.join(dir, id), { recursive: true });
    writeFileSync(path.join(dir, QUARANTINE_MANIFEST), JSON.stringify({ [id]: new Date(now.getTime() - DAY).toISOString() }));
    expect(await emptyQuarantine(now)).toMatchObject({ ok: true, moved: 0 });
    expect(existsSync(path.join(dir, id))).toBe(true);
  });

  it("puts a quarantined folder back when its photo is in the database again, rather than deleting it", async () => {
    await album(40, 2);
    const scan = await findOrphanPhotoFolders(now);
    const [back, blocked] = scan.ok ? scan.orphans : [];
    // Two of 42 is over the cap for one move, so they are put in the quarantine by hand, as a move leaves them.
    for (const id of [back, blocked]) {
      const dayDir = path.join(root, "quarantine", now.toISOString().slice(0, 10));
      mkdirSync(dayDir, { recursive: true });
      renameSync(path.join(root, "photos", id), path.join(dayDir, id));
      const manifest = existsSync(path.join(dayDir, QUARANTINE_MANIFEST)) ? JSON.parse(readFileSync(path.join(dayDir, QUARANTINE_MANIFEST), "utf8")) : {};
      writeFileSync(path.join(dayDir, QUARANTINE_MANIFEST), JSON.stringify({ ...manifest, [id]: now.toISOString() }));
    }
    // A restore since brought both photos back; one of them already has a new folder of its own.
    await row(back);
    await row(blocked);
    folder(blocked, DAY);
    const later = new Date(now.getTime() + QUARANTINE_KEEP_MS + DAY);
    const r = await emptyQuarantine(later);
    expect(r).toMatchObject({ ok: true, moved: 0 });
    expect(r.message).toMatch(new RegExp(`put back in photos/ instead: ${back}`));
    expect(r.message).toMatch(new RegExp(`left in the quarantine: ${blocked}`));
    expect(existsSync(path.join(root, "photos", back, "frames/1.jpg"))).toBe(true);
    expect(existsSync(path.join(root, "quarantine", now.toISOString().slice(0, 10), blocked))).toBe(true);
  });

  it("does not count a folder whose row exists, however old, or one left too recently", async () => {
    const id = cuid();
    await row(id);
    folder(id, 365 * DAY);
    const young = cuid();
    folder(young, ORPHAN_FOLDER_MS - DAY);
    expect(await findOrphanPhotoFolders(now)).toEqual({ ok: true, orphans: [], folders: 2 });
  });
});
