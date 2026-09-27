import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "process-photos-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
const enqueuedOpts = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts?: unknown) => { enqueued.push({ queue, data }); if (queue === "transcode-video") enqueuedOpts.push(opts); } }));

import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";

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

describe("re-processing keeps what a member chose", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    enqueuedOpts.length = 0;
    userId = (await db.user.create({ data: { email: "pp@example.com", role: "ADMIN" } })).id;
  });
  async function stage(fixture: string, data: Record<string, unknown>, file = "original.jpg") {
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: fixture, mimeType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING", ...data } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures", fixture), path.join(photoRoot, key, file));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/${file}` } });
    return photo.id;
  }

  it("keeps a hand-set date and a hand-set place over what the file says (#56)", async () => {
    const id = await stage("photo-with-gps.jpg", { takenAt: new Date("1985-06-01T15:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: userId, lat: 10, lng: 20, gpsSource: "MANUAL", placeSetById: userId });
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: userId, lat: 10, lng: 20, gpsSource: "MANUAL" });
    expect(p.takenAt?.toISOString()).toBe("1985-06-01T15:00:00.000Z");
  });

  it("keeps a hand-set date on a 3D scan (#56)", async () => {
    const id = await stage("scan.glb", { kind: "SCAN", takenAt: new Date("1985-06-01T15:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: 0, dateSetById: userId }, "original.glb");
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", dateSetById: userId });
    expect(p.takenAt?.toISOString()).toBe("1985-06-01T15:00:00.000Z");
  });

  it("reads a 3D scan's file time on its trip's clock, not as UTC (#144)", async () => {
    const trip = await db.trip.create({ data: { slug: "la", title: "LA", timezone: "America/Los_Angeles", startDate: new Date("2025-12-29"), endDate: new Date("2026-01-02"), createdById: userId } });
    // 11:30 PM on New Year's Eve in Los Angeles.
    const id = await stage("scan.glb", { kind: "SCAN", tripId: trip.id, exif: { fileLastModified: Date.parse("2026-01-01T07:30:00Z") } }, "original.glb");
    await processPhoto({ photoId: id, tripId: trip.id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", takenAtSource: "FILE_MTIME", tzOffsetMin: -480, tripId: trip.id });
    expect(p.takenAt?.toISOString()).toBe("2026-01-01T07:30:00.000Z");
  });

  it("keeps a hand-set date with no offset, and records its trip's offset for it, on a photograph and a scan (#144, #146)", async () => {
    const trip = await db.trip.create({ data: { slug: "la", title: "LA", timezone: "America/Los_Angeles", startDate: new Date("2025-12-29"), endDate: new Date("2026-01-02"), createdById: userId } });
    // 11:30 PM on New Year's Eve in Los Angeles, set by hand with no offset of its own.
    const nye = new Date("2026-01-01T07:30:00Z");
    const photo = await stage("photo-with-gps.jpg", { tripId: trip.id, takenAt: nye, takenAtSource: "MANUAL", tzOffsetMin: null, dateSetById: userId });
    const scan = await stage("scan.glb", { kind: "SCAN", tripId: trip.id, takenAt: nye, takenAtSource: "MANUAL", tzOffsetMin: null, dateSetById: userId }, "original.glb");
    await processPhoto({ photoId: photo, tripId: trip.id });
    await processPhoto({ photoId: scan, tripId: trip.id });
    // The date stays as the member set it; the offset it was read on (its trip's clock) is recorded with it.
    expect(await db.photo.findUniqueOrThrow({ where: { id: photo } })).toMatchObject({ status: "READY", takenAt: nye, takenAtSource: "MANUAL", tzOffsetMin: -480, tripId: trip.id });
    // A scan's is written again, on its trip's clock rather than as UTC.
    expect(await db.photo.findUniqueOrThrow({ where: { id: scan } })).toMatchObject({ status: "READY", takenAt: nye, takenAtSource: "MANUAL", tzOffsetMin: -480, tripId: trip.id });
  });

  it("does not put back the file's GPS where a member cleared the place (#72)", async () => {
    const id = await stage("photo-with-gps.jpg", { lat: null, lng: null, gpsSource: null, placeSetById: userId });
    await processPhoto({ photoId: id });
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", lat: null, gpsSource: null });
  });

  it("keeps a photograph a member took off an activity off it (#61)", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2000-01-01"), endDate: new Date("2030-12-31"), createdById: userId } });
    await db.activity.create({ data: { tripId: trip.id, title: "Always", startTime: new Date("2000-01-01T00:00:00Z"), endTime: new Date("2030-12-31T00:00:00Z") } });
    const id = await stage("photo-with-gps.jpg", { tripId: trip.id, activityId: null, activitySetById: userId });
    await processPhoto({ photoId: id, tripId: trip.id });
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", activityId: null, activitySetById: userId });
  });

  it("hands a clip to the transcoder instead of failing it in the photo path (#42)", async () => {
    const id = await stage("clip.mp4", { kind: "VIDEO", status: "READY" }, "original.mp4");
    await processPhoto({ photoId: id });
    expect((await db.photo.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
    expect(enqueued).toEqual([{ queue: "transcode-video", data: { photoId: id, tripId: null } }]);
    expect(enqueuedOpts).toEqual([{ singletonKey: `transcode:${id}` }]);
  });

  it("keeps a clip on the activity it was uploaded into, whatever its clock says (#55)", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2000-01-01"), endDate: new Date("2030-12-31"), createdById: userId } });
    const beach = await db.activity.create({ data: { tripId: trip.id, title: "Beach day", startTime: new Date("2001-01-01T10:00:00Z"), endTime: new Date("2001-01-01T11:00:00Z") } });
    const id = await stage("clip.mp4", { kind: "VIDEO", tripId: trip.id, activityId: beach.id, activitySetById: userId }, "original.mp4");
    await transcodeVideo({ photoId: id, tripId: trip.id });
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", activityId: beach.id, activitySetById: userId });
  });

  it("re-transcodes a clip it already accepted, though it is over today's length limit (#42)", async () => {
    const id = await stage("long-clip.mp4", { kind: "VIDEO", status: "READY", videoRenditions: { mp4: { key: "k", w: 1, h: 1, bytes: 1 }, poster: { key: "p" } } }, "original.mp4");
    await transcodeVideo({ photoId: id });
    expect((await db.photo.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
  }, 120_000);

  it("keeps a clip's hand-set date through a transcode (#56)", async () => {
    const id = await stage("clip.mp4", { kind: "VIDEO", takenAt: new Date("1999-12-31T23:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: 60 }, "original.mp4");
    await transcodeVideo({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", tzOffsetMin: 60 });
    expect(p.takenAt?.toISOString()).toBe("1999-12-31T23:00:00.000Z");
  });
});
