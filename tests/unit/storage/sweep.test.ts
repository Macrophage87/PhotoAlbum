import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** Files that work which died part-way left behind: uploaded track files no import will read again, and photo folders. */
const root = mkdtempSync(path.join(tmpdir(), "storage-sweep-"));
process.env.PHOTO_STORAGE_ROOT = root;
const jobs = vi.hoisted(() => ({ importKeys: new Set<string>() as Set<string> | null }));
// No pg-boss here: what its live import jobs would read is given by each test.
vi.mock("@/lib/jobs/live", () => ({ liveImportKeys: async () => jobs.importKeys }));

import { IMPORT_ABANDONED_MS, ORPHAN_FOLDER_MS, sweepImportFiles, sweepOrphanPhotoFolders } from "@/lib/storage/sweep";

const now = new Date("2026-09-27T12:00:00Z");
/** A file under the storage root, last written `ageMs` before `now`. */
function file(key: string, ageMs: number): string {
  const full = path.join(root, key);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "x");
  const t = new Date(now.getTime() - ageMs);
  utimesSync(full, t, t);
  return full;
}

describe("the sweep of uploaded track files", () => {
  beforeEach(async () => {
    await resetTestDb();
    rmSync(path.join(root, "imports"), { recursive: true, force: true });
    jobs.importKeys = new Set();
  });

  it("deletes one a crashed import left behind, once it is a few hours old", async () => {
    const stale = file("imports/crashed.json", IMPORT_ABANDONED_MS + 60_000);
    const fresh = file("imports/uploading.json", IMPORT_ABANDONED_MS - 60_000);
    expect(await sweepImportFiles(now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps one a live job will still read, and one a track was made from", async () => {
    const queued = file("imports/queued.json", 2 * IMPORT_ABANDONED_MS);
    const kept = file("imports/walk.gpx", 2 * IMPORT_ABANDONED_MS);
    jobs.importKeys = new Set(["imports/queued.json"]);
    const user = await db.user.create({ data: { email: "t@example.com" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: now, endDate: now, createdById: user.id } });
    await db.track.create({ data: { tripId: trip.id, uploaderId: user.id, source: "GPX", name: "Walk", originalFile: "imports/walk.gpx", startTime: now, endTime: now, pointCount: 0, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array() } });
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(kept)).toBe(true);
  });

  it("deletes nothing when it cannot tell which files the queue still needs", async () => {
    const stale = file("imports/unknown.json", 2 * IMPORT_ABANDONED_MS);
    jobs.importKeys = null;
    expect(await sweepImportFiles(now)).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });
});

describe("the sweep of photo folders", () => {
  let uploaderId: string;
  beforeEach(async () => {
    await resetTestDb();
    rmSync(path.join(root, "photos"), { recursive: true, force: true });
    uploaderId = (await db.user.create({ data: { email: "u@example.com" } })).id;
  });
  const row = (id: string) => db.photo.create({ data: { id, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: `photos/${id}`, originalPath: `photos/${id}/original.jpg`, sizeBytes: 1, status: "READY" } });
  /** A folder of files, the folder itself and each file last written `ageMs` before `now`. */
  const folder = (id: string, ageMs: number) => {
    for (const name of ["original.jpg", "thumb.webp"]) file(`photos/${id}/${name}`, ageMs);
    const t = new Date(now.getTime() - ageMs);
    utimesSync(path.join(root, "photos", id), t, t);
    return path.join(root, "photos", id);
  };

  it("deletes a folder whose item was deleted for good, once it has been left a day", async () => {
    const orphan = folder("gone-long-ago", ORPHAN_FOLDER_MS + 60_000);
    expect(await sweepOrphanPhotoFolders(now)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it("never touches a folder whose row exists, however old", async () => {
    await row("still-here");
    const kept = folder("still-here", 30 * ORPHAN_FOLDER_MS);
    expect(await sweepOrphanPhotoFolders(now)).toBe(0);
    expect(existsSync(kept)).toBe(true);
  });

  it("leaves a folder written to recently, even with no row", async () => {
    const recent = folder("just-written", ORPHAN_FOLDER_MS + 60_000);
    // A rendition written an hour ago into an otherwise old folder.
    file("photos/just-written/medium.webp", 3600_000);
    expect(await sweepOrphanPhotoFolders(now)).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });
});
