import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "process-photos-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { processPhoto } from "@/lib/jobs/handlers/process-photo";

describe("processPhoto with Takeout sidecar data", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pp@example.com", role: "ADMIN" } })).id;
  });
  async function stage(fixture: string, data: Record<string, unknown>) {
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: fixture, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING", ...data } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures", fixture), path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
    return photo.id;
  }
  it("keeps the sidecar's instant, takes the zone from EXIF, prefers EXIF GPS, and records the content hash", async () => {
    const id = await stage("photo-with-gps.jpg", { takenAt: new Date("2025-08-12T13:30:00Z"), takenAtSource: "SIDECAR", lat: 10, lng: 10, gpsSource: "SIDECAR" });
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p.status).toBe("READY");
    expect(p.takenAt?.toISOString()).toBe("2025-08-12T13:30:00.000Z");
    expect(p.takenAtSource).toBe("SIDECAR");
    expect(p.gpsSource).toBe("EXIF");
    expect(p.lat).not.toBe(10);
    expect(p.contentHash).toHaveLength(64);
  });
  it("keeps sidecar GPS when the file has none and finds the zone from that position", async () => {
    const id = await stage("photo-no-exif.jpg", { takenAt: new Date("2019-07-03T12:00:00Z"), takenAtSource: "SIDECAR", lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR" });
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", takenAtSource: "SIDECAR", gpsSource: "SIDECAR", lat: 44.3186, lng: -68.1917, tzOffsetMin: -240 });
    expect(p.takenAt?.toISOString()).toBe("2019-07-03T12:00:00.000Z");
  });
  it("falls back to the usual EXIF resolution for ordinary uploads and still hashes them", async () => {
    const id = await stage("photo-with-gps.jpg", {});
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p.takenAtSource).toBe("EXIF_OFFSET");
    expect(p.contentHash).toHaveLength(64);
  });
});
