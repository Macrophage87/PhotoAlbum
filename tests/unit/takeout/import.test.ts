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
// No pg-boss here: no job is waiting for anything.
vi.mock("@/lib/jobs/live", () => ({ hasLiveProcessingJob: async () => false }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { if (refuse.queue === queue) { refuse.queue = null; throw new Error("queue unavailable"); } enqueued.push({ queue, data }); } }));

/** What happens as a stored file is about to take its hash: nothing, a failure, or the same bytes landing by upload. */
const claiming = vi.hoisted(() => ({ file: null as string | null, then: null as null | "fail" | "race", removeStarterAt: 0, claims: 0 }));
vi.mock("@/lib/media/content-hash", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/media/content-hash");
  const { db: store } = await import("@/lib/db");
  return {
    claimContentHash: async (photoId: string, hash: string, data?: Record<string, unknown>) => {
      const row = await store.photo.findUniqueOrThrow({ where: { id: photoId }, select: { originalName: true, uploaderId: true } });
      if (claiming.file === row.originalName && claiming.then === "fail") throw new Error("database went away");
      // The importer's removal begins part-way through the archive.
      if (++claiming.claims === claiming.removeStarterAt) await store.user.update({ where: { id: row.uploaderId }, data: { removingAt: new Date() } });
      if (claiming.file === row.originalName && claiming.then === "race") {
        await store.photo.create({ data: { uploaderId: row.uploaderId, status: "READY", originalName: "uploaded-meanwhile.jpg", mimeType: "image/jpeg", storageKey: "photos/u", originalPath: "photos/u/original.jpg", sizeBytes: 1, contentHash: hash } });
      }
      return real.claimContentHash(photoId, hash, data);
    },
  };
});

/** The importer's removal beginning as the `at`th duplicate is looked at, in a re-import that finds nothing new. */
const onDuplicate = vi.hoisted(() => ({ at: 0, seen: 0, userId: "" }));
vi.mock("@/lib/takeout/repair", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/takeout/repair");
  const { db: store } = await import("@/lib/db");
  return {
    ...real,
    planSidecarRepair: (...args: Parameters<typeof real.planSidecarRepair>) => {
      // Prisma runs a query only once it is awaited or then'd; the import is twenty files from its next look by then.
      if (++onDuplicate.seen === onDuplicate.at) void store.user.update({ where: { id: onDuplicate.userId }, data: { removingAt: new Date() } }).then(() => undefined);
      return real.planSidecarRepair(...args);
    },
  };
});

import { closeDeadImports, importTakeoutArchive, STARTER_REMOVED } from "@/lib/takeout/import";
import { copyFileSync, createWriteStream, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { ZipFile } from "yazl";

describe("importing a Takeout archive", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    refuse.queue = null;
    claiming.file = null;
    claiming.then = null;
    claiming.claims = 0;
    claiming.removeStarterAt = 0;
    onDuplicate.at = onDuplicate.seen = 0;
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
  it("a repaired date keeps an activity a member chose, and drops a pin a track gave the wrong time (#104)", async () => {
    await run();
    const gps = await db.photo.findFirstOrThrow({ where: { originalName: "photo-with-gps.jpg" } });
    const trip = await db.trip.create({ data: { slug: "maine", title: "Maine", startDate: new Date("2025-08-01"), endDate: new Date("2025-09-30"), timezone: "America/New_York", createdById: userId } });
    const summit = await db.activity.create({ data: { tripId: trip.id, title: "Cadillac summit hike", startTime: new Date("2025-09-01T00:00:00Z"), endTime: new Date("2025-09-01T01:00:00Z") } });
    // Dragged onto the hike by hand while it carried only the upload time; the sidecar's real date is outside the hike.
    // Its position was interpolated from a track at that wrong time, so it is wrong too.
    await db.photo.update({ where: { id: gps.id }, data: { tripId: trip.id, activityId: summit.id, activitySetById: userId, takenAt: new Date("2025-09-01T00:30:00Z"), takenAtSource: "UPLOAD_TIME", lat: 44.35, lng: -68.22, gpsSource: "TRACK" } });
    await run();
    const fixed = await db.photo.findUniqueOrThrow({ where: { id: gps.id } });
    // The sidecar's own position fills the place; the stale pin is not kept.
    expect(fixed).toMatchObject({ takenAtSource: "SIDECAR", tripId: trip.id, activityId: summit.id, activitySetById: userId, gpsSource: "SIDECAR", lat: 44.3186 });
    expect(fixed.takenAt?.toISOString()).toBe("2025-08-12T13:30:00.000Z");
  });
  it("a repaired date drops a track pin from the wrong time and takes the trip's zone when there is no other position (#104)", async () => {
    await run();
    const lake = await db.photo.findFirstOrThrow({ where: { originalName: "photo-no-gps.jpg" } });
    const trip = await db.trip.create({ data: { slug: "lake", title: "Lake", startDate: new Date("2019-06-01"), endDate: new Date("2019-07-31"), timezone: "America/New_York", createdById: userId } });
    await db.photo.update({ where: { id: lake.id }, data: { tripId: trip.id, takenAt: new Date("2019-07-20T00:00:00Z"), takenAtSource: "FILE_MTIME", tzOffsetMin: 0, lat: 44.9, lng: -68.9, gpsSource: "TRACK" } });
    await run();
    const fixed = await db.photo.findUniqueOrThrow({ where: { id: lake.id } });
    expect(fixed).toMatchObject({ takenAtSource: "SIDECAR", lat: null, lng: null, gpsSource: null, tzOffsetMin: -240 });
  });
  it("does not give back a place a member deliberately cleared (#72)", async () => {
    await run();
    const gps = await db.photo.findFirstOrThrow({ where: { originalName: "photo-with-gps.jpg" } });
    await db.photo.update({ where: { id: gps.id }, data: { lat: null, lng: null, gpsSource: null, placeSetById: userId } });
    await run();
    expect(await db.photo.findUniqueOrThrow({ where: { id: gps.id } })).toMatchObject({ lat: null, lng: null, gpsSource: null });
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
  it("leaves no half-imported row behind a failure before the photo is claimed, so importing again brings it in", async () => {
    claiming.file = "photo-no-gps.jpg";
    claiming.then = "fail";
    const first = await run();
    expect({ imported: first.imported, failed: first.failed }).toEqual({ imported: 3, failed: 1 });
    // Nothing that looks imported, no file with no row, and no row still waiting for a file.
    expect(await db.photo.count()).toBe(3);
    expect(await db.photo.count({ where: { originalPath: "pending" } })).toBe(0);
    const stored = readdirSync(path.join(photoRoot, "photos"));
    expect((await db.photo.findMany({ select: { id: true } })).every((p) => stored.includes(p.id))).toBe(true);
    // Nor a place in its album for a photo that is not there.
    expect((first.report as { albums: { items: number }[] }).albums[0].items).toBe(2);
    claiming.then = null;
    const again = await run();
    expect({ imported: again.imported, failed: again.failed }).toEqual({ imported: 1, failed: 0 });
    expect(await db.photo.count()).toBe(4);
  });
  it("keeps a claimed photo whose processing could not be queued, and queues it on the next run", async () => {
    refuse.queue = "transcode-video";
    const first = await run();
    expect(first.failed).toBe(1);
    const clip = await db.photo.findFirstOrThrow({ where: { originalName: "clip.mp4" } });
    expect(clip).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Re-process/) });
    expect(clip.originalPath).not.toBe("pending");
    await db.photo.update({ where: { id: clip.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    enqueued.length = 0;
    const again = await run();
    expect(again.imported).toBe(0);
    expect(enqueued).toEqual([{ queue: "transcode-video", data: { photoId: clip.id, tripId: null } }]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("PENDING");
  });
  it("gives way to the same bytes arriving by upload while it stored them, and files that one in the album", async () => {
    claiming.file = "photo-no-gps.jpg";
    claiming.then = "race";
    const r = await run();
    expect({ imported: r.imported, failed: r.failed }).toEqual({ imported: 3, failed: 0 });
    expect((r.report as { duplicates: number }).duplicates).toBe(2);
    expect(await db.photo.count({ where: { originalName: "photo-no-gps.jpg" } })).toBe(0);
    const keeper = await db.photo.findFirstOrThrow({ where: { originalName: "uploaded-meanwhile.jpg" } });
    const album = await db.collection.findFirstOrThrow({ where: { title: "Lake House" }, include: { items: true } });
    expect(album.items.map((i) => i.photoId)).toContain(keeper.id);
    expect(album.items).toHaveLength(3);
    expect((r.report as { albums: { items: number }[] }).albums[0].items).toBe(3);
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
  it("passes over a photo in the trash, neither bringing it back nor touching it, and says how many", async () => {
    await run();
    await db.photo.updateMany({ where: { originalName: "photo-with-gps.jpg" }, data: { trashedAt: new Date(), trashReason: "OTHER", lat: null, lng: null, gpsSource: null } });
    const again = await run();
    expect(again.imported).toBe(0);
    expect((again.report as { inTrash: number }).inTrash).toBe(2);
    expect(await db.photo.count({ where: { originalName: "photo-with-gps.jpg" } })).toBe(1);
    expect(await db.photo.findFirstOrThrow({ where: { originalName: "photo-with-gps.jpg" } })).toMatchObject({ lat: null, trashedAt: expect.any(Date) });
  });
  it("finds a photo brought in through the Picker by its name and capture time, and repairs it instead of importing it twice", async () => {
    // The Picker copy: other bytes, the Picker's own id, no position, and a date read from EXIF in another zone.
    const picked = await db.photo.create({ data: { uploaderId: userId, sourceKind: "GOOGLE_PICKER", sourceId: "picker-id", status: "READY", originalName: "photo-with-gps.jpg", mimeType: "image/jpeg", storageKey: "photos/p", originalPath: "photos/p/original.jpg", sizeBytes: 5, contentHash: "0".repeat(64), takenAt: new Date("2025-08-12T17:30:00.000Z"), takenAtSource: "EXIF_TZLOOKUP", width: 800, height: 1200 } });
    // Same name, but a different moment: a different photograph.
    await db.photo.create({ data: { uploaderId: userId, sourceKind: "GOOGLE_PICKER", sourceId: "other", status: "READY", originalName: "photo-no-gps.jpg", mimeType: "image/jpeg", storageKey: "photos/q", originalPath: "photos/q/original.jpg", sizeBytes: 5, takenAt: new Date("2025-08-12T17:31:07.000Z"), takenAtSource: "EXIF_TZLOOKUP" } });
    const r = await run();
    expect(r.imported).toBe(3);
    expect(await db.photo.count({ where: { originalName: "photo-with-gps.jpg" } })).toBe(1);
    expect(await db.photo.findUniqueOrThrow({ where: { id: picked.id } })).toMatchObject({ lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR" });
    expect(await db.photo.count({ where: { originalName: "photo-no-gps.jpg" } })).toBe(2);
  });
  it.each([
    ["seven minutes off, which no time zone explains", { takenAt: new Date("2025-08-12T13:37:00.000Z") }],
    ["on another day altogether", { takenAt: new Date("2025-08-14T13:30:00.000Z") }],
    ["another member's", { mine: false }],
    ["a different size", { width: 640, height: 480 }],
  ])("does not take a Picker photo of the same name that is %s", async (_why, over: { takenAt?: Date; mine?: boolean; width?: number; height?: number }) => {
    const other = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    await db.photo.create({ data: { uploaderId: over.mine === false ? other.id : userId, sourceKind: "GOOGLE_PICKER", sourceId: "picker-id", status: "READY", originalName: "photo-with-gps.jpg", mimeType: "image/jpeg", storageKey: "photos/p", originalPath: "photos/p/original.jpg", sizeBytes: 5, takenAt: over.takenAt ?? new Date("2025-08-12T17:30:00.000Z"), takenAtSource: "EXIF_TZLOOKUP", width: over.width ?? 800, height: over.height ?? 1200 } });
    const r = await run();
    expect(r.imported).toBe(4);
    expect(await db.photo.count({ where: { originalName: "photo-with-gps.jpg" } })).toBe(2);
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
  it("takes TIFF and AVIF, counts formats it cannot take, and fails an empty file with a reason", async () => {
    const pixels = sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 80, b: 40 } } });
    const zip = new ZipFile();
    zip.addBuffer(await pixels.clone().tiff().toBuffer(), "Takeout/Google Photos/Scans/letter.tif");
    zip.addBuffer(await pixels.clone().avif().toBuffer(), "Takeout/Google Photos/Photos from 2025/sunset.avif");
    zip.addBuffer(Buffer.from("raw sensor data"), "Takeout/Google Photos/Photos from 2025/IMG_0001.dng");
    zip.addBuffer(Buffer.alloc(0), "Takeout/Google Photos/Photos from 2025/broken.jpg");
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(path.join(inbox, "takeout-formats.zip")));
    const row = await db.takeoutImport.create({ data: { archiveName: "takeout-formats.zip", startedById: userId } });
    await importTakeoutArchive(row.id);
    const r = await db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } });
    expect({ imported: r.imported, skipped: r.skipped, failed: r.failed }).toEqual({ imported: 2, skipped: 1, failed: 1 });
    const report = r.report as { unsupported: number; failures: { file: string; reason: string }[] };
    expect(report.unsupported).toBe(1);
    expect(report.failures).toEqual([{ file: "broken.jpg", reason: "The file in the archive is empty (0 bytes)." }]);
    expect((await db.photo.findMany({ select: { mimeType: true }, orderBy: { mimeType: "asc" } })).map((p) => p.mimeType)).toEqual(["image/avif", "image/tiff"]);
  });
  it("refuses names outside the inbox", async () => {
    const row = await db.takeoutImport.create({ data: { archiveName: "../etc/passwd.zip", startedById: userId } });
    await importTakeoutArchive(row.id);
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("FAILED");
  });

  it("never starts for a member being removed, and stops within 25 files once their removal begins", async () => {
    const pixels = sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 80, b: 40 } } });
    const zip = new ZipFile();
    for (let i = 0; i < 60; i++) zip.addBuffer(await pixels.clone().png({ palette: false }).composite([{ input: Buffer.from([i, i, i, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 0, top: 0 }]).toBuffer(), `Takeout/Google Photos/Photos from 2025/p${i}.png`);
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(path.join(inbox, "takeout-many.zip")));

    claiming.removeStarterAt = 10;
    const row = await db.takeoutImport.create({ data: { archiveName: "takeout-many.zip", startedById: userId } });
    await importTakeoutArchive(row.id);
    const r = await db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.status).toBe("FAILED");
    expect((r.report as { failures: { reason: string }[] }).failures).toContainEqual({ file: "takeout-many.zip", reason: STARTER_REMOVED });
    expect(r.imported).toBe(25);
    expect(await db.photo.count()).toBe(25);

    // One queued before the removal began never starts.
    const queued = await db.takeoutImport.create({ data: { archiveName: "takeout-many.zip", startedById: userId } });
    await importTakeoutArchive(queued.id);
    expect(await db.takeoutImport.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: "FAILED", imported: 0 });
    expect(await db.photo.count()).toBe(25);
  }, 60_000);

  it("stops a re-import that finds nothing but duplicates, too, once the importer's removal begins", async () => {
    const pixels = sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 90, g: 20, b: 140 } } });
    const zip = new ZipFile();
    for (let i = 0; i < 60; i++) zip.addBuffer(await pixels.clone().png({ palette: false }).composite([{ input: Buffer.from([i, 255 - i, i, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 1, top: 1 }]).toBuffer(), `Takeout/Google Photos/Photos from 2024/d${i}.png`);
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(path.join(inbox, "takeout-dupes.zip")));
    const first = await db.takeoutImport.create({ data: { archiveName: "takeout-dupes.zip", startedById: userId } });
    await importTakeoutArchive(first.id);
    expect((await db.takeoutImport.findUniqueOrThrow({ where: { id: first.id } })).imported).toBe(60);

    onDuplicate.userId = userId;
    onDuplicate.at = 5;
    const again = await db.takeoutImport.create({ data: { archiveName: "takeout-dupes.zip", startedById: userId } });
    await importTakeoutArchive(again.id);
    const a = await db.takeoutImport.findUniqueOrThrow({ where: { id: again.id } });
    expect(a).toMatchObject({ status: "FAILED", imported: 0, skipped: 25 });
    expect((a.report as { failures: { reason: string }[] }).failures).toContainEqual({ file: "takeout-dupes.zip", reason: STARTER_REMOVED });
    expect(await db.photo.count()).toBe(60);
  }, 60_000);
});
