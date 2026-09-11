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
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));

import { closeDeadImports, importTakeoutArchive } from "@/lib/takeout/import";
import { copyFileSync } from "node:fs";

describe("importing a Takeout archive", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
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
    expect(album.items.map((i) => i.photoId).sort()).toEqual([lake.id, clip.id].sort());
    expect(enqueued.map((e) => e.queue).sort()).toEqual(["process-photo", "process-photo", "process-photo", "transcode-video"]);
    const report = r.report as { duplicates: number; albums: { title: string; created: boolean }[] };
    expect(report.duplicates).toBe(1);
    expect(report.albums).toEqual([{ title: "Lake House", items: 2, created: true }]);
  });
  it("is idempotent: a second run of the same archive imports nothing", async () => {
    await run();
    const again = await run();
    expect({ imported: again.imported, skipped: again.skipped }).toEqual({ imported: 0, skipped: 5 });
    expect(await db.photo.count()).toBe(4);
    expect(await db.collection.count()).toBe(1);
  });
  it("never files an album into a public or link-shared collection of the same name", async () => {
    await db.collection.create({ data: { slug: "lake-house", title: "Lake House", themeKey: "default", visibility: "PUBLIC", createdById: userId } });
    const r = await run();
    expect(r.collectionsCreated).toBe(1);
    const all = await db.collection.findMany({ where: { title: "Lake House" }, orderBy: { slug: "asc" }, include: { items: true } });
    expect(all.map((c) => [c.slug, c.visibility, c.items.length])).toEqual([["lake-house", "PUBLIC", 0], ["lake-house-2", "PRIVATE", 2]]);
  });
  it("reuses a private, unshared collection of the same name", async () => {
    const mine = await db.collection.create({ data: { slug: "lake-house", title: "Lake House", themeKey: "default", visibility: "PRIVATE", createdById: userId } });
    const r = await run();
    expect(r.collectionsCreated).toBe(0);
    expect(await db.collectionItem.count({ where: { collectionId: mine.id } })).toBe(2);
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
