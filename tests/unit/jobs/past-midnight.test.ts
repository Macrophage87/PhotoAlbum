import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "past-midnight-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));
// Something done while a job renders, after it read the row and before it writes back (as in process-race.test.ts).
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/images/renditions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/images/renditions")>();
  return {
    ...real,
    makeRenditions: async (...args: Parameters<typeof real.makeRenditions>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.makeRenditions(...args);
    },
  };
});

import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";
import { applyPhotoInstant } from "@/lib/photos/apply-date";

const M = 60_000;
// The trip runs 10–16 August in New York (EDT, UTC-4).
const RIDE_START = Date.parse("2025-08-17T02:30:00Z"); // 22:30 on the 16th, its last evening
const RIDE_END = Date.parse("2025-08-17T05:15:00Z"); // 01:15 on the 17th, the day after it ends

describe("a photograph from a ride that runs past a trip's last midnight", () => {
  let userId: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    userId = (await db.user.create({ data: { email: "rider@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/New_York", createdById: userId } })).id;
  });

  async function ride(onTrip: string, from: number, to: number, withTrack = true) {
    let trackId: string | null = null;
    if (withTrack) {
      // Heading north a little every five minutes.
      const points: TrackPoint[] = [];
      for (let t = from, i = 0; t <= to; t += 5 * M, i++) points.push({ t, lat: 44.3 + i * 0.001, lng: -68.2 });
      const { blob, startTime, endTime } = encodePoints(points);
      trackId = (await db.track.create({ data: { tripId: onTrip, uploaderId: userId, source: "GPX", name: "Night ride", startTime, endTime, pointCount: points.length, minLat: 44.3, maxLat: 44.4, minLng: -68.2, maxLng: -68.2, simplified: [], pointsBlob: new Uint8Array(blob) } })).id;
    }
    return db.activity.create({ data: { tripId: onTrip, title: "Night ride", type: "BIKE", startTime: new Date(from), endTime: new Date(to), trackId } });
  }

  /** A photograph whose camera wrote `wall` with the zone `offset`, uploaded with no trip chosen. */
  async function upload(wall: string, offset = "-04:00") {
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: "ride.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING" } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 20, b: 60 } } })
      .jpeg()
      .withExif({ IFD0: { Make: "Canon", Model: "EOS R6" }, IFD2: { DateTimeOriginal: wall, OffsetTimeOriginal: offset } })
      .toFile(path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
    await processPhoto({ photoId: photo.id });
    return db.photo.findUniqueOrThrow({ where: { id: photo.id } });
  }

  it("is filed on the trip and the ride, and placed from its track, at 00:40 the day after the trip ends", async () => {
    const r = await ride(tripId, RIDE_START, RIDE_END);
    const p = await upload("2025:08:17 00:40:00");
    expect(p.takenAt?.toISOString()).toBe("2025-08-17T04:40:00.000Z");
    expect(p).toMatchObject({ status: "READY", tripId, activityId: r.id });

    expect((await geotagPhotos({ tripId })).updated).toBe(1);
    const placed = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
    // 130 minutes into the ride: 26 five-minute steps north of where it set out.
    expect(placed).toMatchObject({ gpsSource: "TRACK", lng: -68.2 });
    expect(placed.lat).toBeCloseTo(44.326, 6);
  });

  it("is filed on the trip from a ride that set out at 23:30 the evening before its first day", async () => {
    const r = await ride(tripId, Date.parse("2025-08-10T03:30:00Z"), Date.parse("2025-08-10T05:00:00Z"), false);
    const p = await upload("2025:08:09 23:45:00");
    expect(p).toMatchObject({ tripId, activityId: r.id });
  });

  it("stays off every trip where nothing was running at that moment, or where two trips were", async () => {
    await ride(tripId, RIDE_START, RIDE_END);
    // An hour after the ride ended: nothing covers it.
    expect(await upload("2025:08:17 02:20:00")).toMatchObject({ tripId: null, activityId: null });

    const other = await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-17"), endDate: new Date("2025-08-20"), timezone: "America/New_York", createdById: userId } });
    await ride(other.id, RIDE_START, RIDE_END, false);
    // Both trips ride at 00:40, but it is on the second trip's first day: that decides it, as before.
    expect(await upload("2025:08:17 00:40:00")).toMatchObject({ tripId: other.id });
    // Moved off its days, two trips are still out at 00:40 UTC-4 the day before: no answer.
    await db.trip.update({ where: { id: other.id }, data: { startDate: new Date("2025-08-18") } });
    expect(await upload("2025:08:17 00:40:00")).toMatchObject({ tripId: null });
  });

  it("files a clip from the ride the same way", async () => {
    const r = await ride(tripId, RIDE_START, RIDE_END);
    // Google's own record of when it was filmed, as a Takeout sidecar gives it.
    const clip = await db.photo.create({ data: { uploaderId: userId, originalName: "clip.mp4", mimeType: "video/mp4", kind: "VIDEO", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING", takenAt: new Date("2025-08-17T04:40:00Z"), takenAtSource: "SIDECAR" } });
    const key = `photos/${clip.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures/clip.mp4"), path.join(photoRoot, key, "original.mp4"));
    await db.photo.update({ where: { id: clip.id }, data: { storageKey: key, originalPath: `${key}/original.mp4` } });
    await transcodeVideo({ photoId: clip.id, tripId: null });
    expect(await db.photo.findUniqueOrThrow({ where: { id: clip.id } })).toMatchObject({ status: "READY", tripId, activityId: r.id });
  });

  it("goes by the trip's rides as they are when the job writes back, not when it started", async () => {
    // The ride is saved while the photo renders: it still takes it.
    let rideId = "";
    meanwhile.run = async () => (rideId = (await ride(tripId, RIDE_START, RIDE_END)).id);
    expect(await upload("2025:08:17 00:40:00")).toMatchObject({ tripId, activityId: expect.any(String) });
    expect(rideId).not.toBe("");

    // And one deleted while the next renders no longer does.
    meanwhile.run = () => db.activity.deleteMany({ where: { id: rideId } }).then(() => db.track.deleteMany({}));
    expect(await upload("2025:08:17 00:45:00")).toMatchObject({ tripId: null, activityId: null });
  });

  it("is not pulled onto a trip whose dates are nowhere near it by a track filed there by mistake", async () => {
    // A trip of 1–5 August, with a ride running at 00:40 on the 17th: a GPX imported into the wrong trip.
    const early = await db.trip.create({ data: { slug: "early", title: "Early", startDate: new Date("2025-08-01"), endDate: new Date("2025-08-05"), timezone: "America/New_York", createdById: userId } });
    await ride(early.id, RIDE_START, RIDE_END);
    expect(await upload("2025:08:17 00:40:00")).toMatchObject({ tripId: null, activityId: null });
    // The same ride on the trip it belongs to still takes it.
    const r = await ride(tripId, RIDE_START, RIDE_END);
    expect(await upload("2025:08:17 00:45:00")).toMatchObject({ tripId, activityId: r.id });
  });

  it("goes only by a date the album trusts: not a file's modified time, nor the upload time", async () => {
    await ride(tripId, RIDE_START, RIDE_END);
    // No date in the file: the browser's modified time, 00:40 on the 17th, is all there is.
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: "copied.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING", exif: { fileLastModified: Date.parse("2025-08-17T04:40:00Z") } } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures/photo-no-exif.jpg"), path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
    await processPhoto({ photoId: photo.id });
    expect(await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ takenAtSource: "FILE_MTIME", tripId: null, activityId: null });

    const other = await db.photo.create({ data: { uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    expect(await applyPhotoInstant({ ...other }, new Date("2025-08-17T04:40:00Z"), -240, "UPLOAD_TIME", null)).toBeNull();
  });

  it("follows a date set by hand onto the trip the ride was on", async () => {
    const r = await ride(tripId, RIDE_START, RIDE_END);
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    const on = await applyPhotoInstant({ ...photo }, new Date("2025-08-17T04:40:00Z"), -240, "MANUAL", userId);
    expect(on).toBe(tripId);
    expect(await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ tripId, activityId: r.id });
  });
});
