import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** Files that work which died part-way left behind: uploaded track files no import will read again. */
const root = mkdtempSync(path.join(tmpdir(), "storage-sweep-"));
process.env.PHOTO_STORAGE_ROOT = root;
const jobs = vi.hoisted(() => ({ importKeys: new Set<string>() as Set<string> | null }));
// No pg-boss here: what its live import jobs would read is given by each test.
vi.mock("@/lib/jobs/live", () => ({ liveImportKeys: async () => jobs.importKeys }));

import { IMPORT_ABANDONED_MS, sweepImportFiles } from "@/lib/storage/sweep";

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
