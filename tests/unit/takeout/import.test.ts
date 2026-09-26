import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const inbox = mkdtempSync(path.join(tmpdir(), "takeout-inbox-"));
const photoRoot = mkdtempSync(path.join(tmpdir(), "takeout-photos-"));
vi.hoisted(() => { /* env is read once, so it is set from the module-level constants below */ });
process.env.IMPORT_INBOX_DIR = inbox;
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
/** A queue whose next enqueue fails, as pg-boss does when its database connection drops. */
const refuse = vi.hoisted(() => ({ queue: null as string | null }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { if (refuse.queue === queue) { refuse.queue = null; throw new Error("queue unavailable"); } enqueued.push({ queue, data }); } }));

import { closeDeadImports, importTakeoutArchive } from "@/lib/takeout/import";
import { copyFileSync, readdirSync } from "node:fs";

describe("importing a Takeout archive", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    refuse.queue = null;
    userId = (await db.user.create({ data: { email: "t@example.com", role: "ADMIN" } })).id;
    copyFileSync(path.join(process.cwd(), "tests/fixtures/takeout.zip"), path.join(inbox, "takeout-001.zip"));
  });
  async function run() {
    const row = await db.takeoutImport.create({ data: { archiveName: "takeout-001.zip", startedById: userId } });
    await importTakeoutArchive(row.id);
    return db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } });
  }
  it("creates rows with sidecar dates, positions and notes, albums as private collections, and skips duplicates", async () => {
    const r = await run();
    expect(r.status).toBe("ENDED");
    expect({ imported: r.imported, skipped: r.skipped, failed: r.failed, collectionsCreated: r.collectionsCreated }).toEqual({ imported: 4, skipped: 1, failed: 0, collectionsCreated: 1 });
    const gps = await db.photo.findFirstOrThrow({ where: { originalName: "photo-with-gps.jpg" } });
    expect(gps).toMatchObject({ sourceKind: "TAKEOUT", sourceId: "AF1QipMockOtterCliff", takenAtSource: "SIDECAR", gpsSource: "SIDECAR", lat: 44.3186, lng: -68.1917, context: "Otter Cliff from the Ocean Path", status: "PENDING" });
    expect(gps.takenAt?.toISOString()).toBe("2025-08-12T13:30:00.000Z");
    expect(gps.contentHash).toHaveLength(64);
    expect(gps.sizeBytes).toBeGreaterThan(0);
    const lake = await db.photo.findFirstOrThrow({ where: { originalName: "photo-no-gps.jpg" } });
    expect(lake).toMatchObject({ gpsSource: null, lat: null, takenAtSource: "SIDECAR", context: "Morning at the lake" });
    const clip = await db.photo.findFirstOrThrow({ where: { originalName: "clip.mp4" } });
    expect(clip.kind).toBe("VIDEO");
    const album = await db.collection.findFirstOrThrow({ where: { title: "Lake House" }, include: { items: true } });
    expect(album.visibility).toBe("PRIVATE");
    expect(album.shareToken).toBeNull();
    // The album folder also holds a counter-suffixed copy of the year-bin photo, as real exports do; it joins the
    // collection without being imported twice.
    expect(album.items.map((i) => i.photoId).sort()).toEqual([lake.id, clip.id, gps.id].sort());
    expect(enqueued.map((e) => e.queue).sort()).toEqual(["process-photo", "process-photo", "process-photo", "transcode-video"]);
    const report = r.report as { duplicates: number; albums: { title: string; created: boolean }[] };
    expect(report.duplicates).toBe(1);
    expect(report.albums).toEqual([{ title: "Lake House", items: 3, created: true }]);
  });
  it("is idempotent: a second run of the same archive imports nothing and repairs nothing", async () => {
    await run();
    const again = await run();
    expect({ imported: again.imported, skipped: again.skipped, repaired: again.repaired }).toEqual({ imported: 0, skipped: 5, repaired: 0 });
    expect(await db.photo.count()).toBe(4);
    expect(await db.collection.count()).toBe(1);
    expect(await db.collectionItem.count()).toBe(3);
  });
  it("a second run gives back a place and a date the album lost, and leaves what the family wrote alone", async () => {
    await run();
    const gps = await db.photo.findFirstOrThrow({ where: { originalName: "photo-with-gps.jpg" } });
    const lake = await db.photo.findFirstOrThrow({ where: { originalName: "photo-no-gps.jpg" } });
    // As a phone upload arrives once Android has removed the position, with only the file's own date to go on.
    await db.photo.update({ where: { id: gps.id }, data: { lat: null, lng: null, gpsSource: null, takenAt: new Date("2025-09-01T00:00:00Z"), takenAtSource: "FILE_MTIME", context: null, sourceId: null } });
    // A member has since written their own note on the other one; the import must not touch it.
    await db.photo.update({ where: { id: lake.id }, data: { context: "Nana wrote this" } });
    const again = await run();
    expect({ imported: again.imported, repaired: again.repaired }).toEqual({ imported: 0, repaired: 1 });
    const fixed = await db.photo.findUniqueOrThrow({ where: { id: gps.id } });
    expect(fixed).toMatchObject({ lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR", takenAtSource: "SIDECAR", context: "Otter Cliff from the Ocean Path", sourceId: "AF1QipMockOtterCliff" });
    expect(fixed.takenAt?.toISOString()).toBe("2025-08-12T13:30:00.000Z");
    expect((await db.photo.findUniqueOrThrow({ where: { id: lake.id } })).context).toBe("Nana wrote this");
    expect((again.report as { repairs: string[] }).repairs).toEqual(["photo-with-gps.jpg: place, date, notes, Google id"]);
  });
  it("puts a photo that is already in the album into its Google album's collection", async () => {
    await run();
    const album = await db.collection.findFirstOrThrow({ where: { title: "Lake House" } });
    await db.collectionItem.deleteMany({ where: { collectionId: album.id } });
    const again = await run();
    expect(again.imported).toBe(0);
    expect(await db.collectionItem.count({ where: { collectionId: album.id } })).toBe(3);
    expect(await db.collection.count()).toBe(1);
  });
  it("never files an album into a public or link-shared collection of the same name", async () => {
    await db.collection.create({ data: { slug: "lake-house", title: "Lake House", themeKey: "default", visibility: "PUBLIC", createdById: userId } });
    const r = await run();
    expect(r.collectionsCreated).toBe(1);
    const all = await db.collection.findMany({ where: { title: "Lake House" }, orderBy: { slug: "asc" }, include: { items: true } });
    expect(all.map((c) => [c.slug, c.visibility, c.items.length])).toEqual([["lake-house", "PUBLIC", 0], ["lake-house-2", "PRIVATE", 3]]);
  });
  it("reuses a private, unshared collection of the same name", async () => {
    const mine = await db.collection.create({ data: { slug: "lake-house", title: "Lake House", themeKey: "default", visibility: "PRIVATE", createdById: userId } });
    const r = await run();
    expect(r.collectionsCreated).toBe(0);
    expect(await db.collectionItem.count({ where: { collectionId: mine.id } })).toBe(3);
  });
  it("leaves no half-imported row behind a failure, so importing again brings the photo in", async () => {
    // The clip is the one whose processing cannot be queued.
    refuse.queue = "transcode-video";
    const first = await run();
    expect({ imported: first.imported, failed: first.failed }).toEqual({ imported: 3, failed: 1 });
    // Nothing that looks imported, no file with no row, and no row still waiting for a file.
    expect(await db.photo.count()).toBe(3);
    expect(await db.photo.count({ where: { originalPath: "pending" } })).toBe(0);
    const stored = readdirSync(path.join(photoRoot, "photos"));
    expect((await db.photo.findMany({ select: { id: true } })).every((p) => stored.includes(p.id))).toBe(true);
    const again = await run();
    expect({ imported: again.imported, failed: again.failed }).toEqual({ imported: 1, failed: 0 });
    expect(await db.photo.count()).toBe(4);
  });
  it("takes over a row an interrupted run left without its file, rather than calling it a duplicate", async () => {
    // As a worker restart between making the row and storing its bytes leaves it.
    await db.photo.create({ data: { uploaderId: userId, sourceKind: "TAKEOUT", sourceId: "AF1QipMockOtterCliff", status: "PENDING", originalName: "photo-with-gps.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 } });
    const r = await run();
    expect(r.imported).toBe(4);
    const rows = await db.photo.findMany({ where: { originalName: "photo-with-gps.jpg" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].originalPath).not.toBe("pending");
  });
  it("does not count a photo in the trash as already in the album", async () => {
    await run();
    await db.photo.updateMany({ where: { originalName: "photo-with-gps.jpg" }, data: { trashedAt: new Date(), trashReason: "OTHER" } });
    const again = await run();
    expect(again.imported).toBe(1);
    expect(await db.photo.count({ where: { originalName: "photo-with-gps.jpg", trashedAt: null } })).toBe(1);
  });
  it("finds a photo brought in through the Picker by its name and capture time, and repairs it instead of importing it twice", async () => {
    // The Picker copy: other bytes, the Picker's own id, no position, and a date read from EXIF in another zone.
    const picked = await db.photo.create({ data: { uploaderId: userId, sourceKind: "GOOGLE_PICKER", sourceId: "picker-id", status: "READY", originalName: "photo-with-gps.jpg", mimeType: "image/jpeg", storageKey: "photos/p", originalPath: "photos/p/original.jpg", sizeBytes: 5, contentHash: "0".repeat(64), takenAt: new Date("2025-08-12T17:30:00.000Z"), takenAtSource: "EXIF_TZLOOKUP" } });
    // Same name, but a different moment: a different photograph.
    await db.photo.create({ data: { uploaderId: userId, sourceKind: "GOOGLE_PICKER", sourceId: "other", status: "READY", originalName: "photo-no-gps.jpg", mimeType: "image/jpeg", storageKey: "photos/q", originalPath: "photos/q/original.jpg", sizeBytes: 5, takenAt: new Date("2025-08-12T17:31:07.000Z"), takenAtSource: "EXIF_TZLOOKUP" } });
    const r = await run();
    expect(r.imported).toBe(3);
    expect(await db.photo.count({ where: { originalName: "photo-with-gps.jpg" } })).toBe(1);
    expect(await db.photo.findUniqueOrThrow({ where: { id: picked.id } })).toMatchObject({ lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR" });
    expect(await db.photo.count({ where: { originalName: "photo-no-gps.jpg" } })).toBe(2);
  });
  it("does not file an album into another member's private collection of the same name", async () => {
    const other = await db.user.create({ data: { email: "mom@example.com", role: "MEMBER" } });
    const hers = await db.collection.create({ data: { slug: "lake-house", title: "Lake House", themeKey: "default", visibility: "PRIVATE", createdById: other.id } });
    const r = await run();
    expect(r.collectionsCreated).toBe(1);
    expect(await db.collectionItem.count({ where: { collectionId: hers.id } })).toBe(0);
  });
  it("closes a run whose worker stopped sending heartbeats", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const dead = await db.takeoutImport.create({ data: { archiveName: "old.zip", startedById: userId, startedAt: old, heartbeatAt: old } });
    const live = await db.takeoutImport.create({ data: { archiveName: "live.zip", startedById: userId, heartbeatAt: new Date() } });
    const fresh = await db.takeoutImport.create({ data: { archiveName: "fresh.zip", startedById: userId } });
    expect(await closeDeadImports()).toBe(1);
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: dead.id } })).status).toBe("FAILED");
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("RUNNING");
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("RUNNING");
  });
  it("refuses names outside the inbox", async () => {
    const row = await db.takeoutImport.create({ data: { archiveName: "../etc/passwd.zip", startedById: userId } });
    await importTakeoutArchive(row.id);
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("FAILED");
  });
});
