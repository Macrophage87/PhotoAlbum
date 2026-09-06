import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

const T0 = Date.parse("2025-08-12T13:00:00Z");
const line = (n: number, from = 0): TrackPoint[] => Array.from({ length: n }, (_, i) => ({ t: T0 + (from + i) * 60_000, lat: 44 + (from + i) * 0.001, lng: -68, ele: 100 + i }));

async function makeTrack(tripId: string, userId: string, points: TrackPoint[], source: "GPX" | "GOOGLE") {
  const { blob, startTime, endTime } = encodePoints(points);
  return db.track.create({
    data: { tripId, uploaderId: userId, source, name: source, startTime, endTime, pointCount: points.length, minLat: 44, maxLat: 45, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) },
  });
}

async function makePhoto(tripId: string, userId: string, takenAt: Date | null, extra: Record<string, unknown> = {}) {
  return db.photo.create({
    data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt, takenAtSource: takenAt ? "EXIF_OFFSET" : null, ...extra },
  });
}

describe("geotagPhotos", () => {
  let tripId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "g@example.com", role: "ADMIN" } });
    userId = user.id;
    const trip = await db.trip.create({ data: { slug: "g", title: "G", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    tripId = trip.id;
  });

  it("positions photos inside a track window and leaves the rest alone", async () => {
    await makeTrack(tripId, userId, line(10), "GPX");
    const inside = await makePhoto(tripId, userId, new Date(T0 + 4.5 * 60_000));
    const outside = await makePhoto(tripId, userId, new Date(T0 + 60 * 60_000));
    const untimed = await makePhoto(tripId, userId, null);
    const hasGps = await makePhoto(tripId, userId, new Date(T0 + 2 * 60_000), { lat: 1, lng: 2, gpsSource: "EXIF" });
    const untrusted = await makePhoto(tripId, userId, new Date(T0 + 2 * 60_000), { takenAtSource: "UPLOAD_TIME" });

    const { updated } = await geotagPhotos({ tripId });
    expect(updated).toBe(1);
    const p = await db.photo.findUniqueOrThrow({ where: { id: inside.id } });
    expect(p.gpsSource).toBe("TRACK");
    expect(p.lat).toBeCloseTo(44.0045, 5);
    expect(p.altitude).toBeCloseTo(104.5, 3);
    for (const id of [outside.id, untimed.id, untrusted.id]) expect((await db.photo.findUniqueOrThrow({ where: { id } })).gpsSource).toBeNull();
    const g = await db.photo.findUniqueOrThrow({ where: { id: hasGps.id } });
    expect(g.lat).toBe(1);
    expect(g.gpsSource).toBe("EXIF");
  });

  it("prefers an activity track over a Google trace covering the same moment", async () => {
    await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: 50 })), "GOOGLE");
    await makeTrack(tripId, userId, line(10), "GPX");
    const photo = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    const p = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(p.lat).toBeCloseTo(44.003, 5);
  });

  it("is a no-op without tracks or candidates", async () => {
    expect(await geotagPhotos({ tripId })).toEqual({ updated: 0 });
    await makePhoto(tripId, userId, new Date(T0));
    expect(await geotagPhotos({ tripId })).toEqual({ updated: 0 });
  });
});

describe("geotagPhotos upgrades coarse positions", () => {
  let tripId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "g2@example.com", role: "ADMIN" } });
    userId = user.id;
    const trip = await db.trip.create({ data: { slug: "g2", title: "G2", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    tripId = trip.id;
  });

  it("re-positions a photo placed from a Google trace once a GPX track covering it is imported", async () => {
    const google = await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lng: -70 })), "GOOGLE");
    const photo = await makePhoto(tripId, userId, new Date(T0 + 4.5 * 60_000));
    await geotagPhotos({ tripId, trackIds: [google.id] });
    const coarse = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(coarse.gpsSource).toBe("TRACK");
    expect(coarse.lng).toBeCloseTo(-70, 5);

    const gpx = await makeTrack(tripId, userId, line(10), "GPX");
    await geotagPhotos({ tripId, trackIds: [gpx.id] });
    const precise = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(precise.gpsSource).toBe("TRACK");
    expect(precise.lng).toBeCloseTo(-68, 5);
  });

  it("does not move a track-placed photo for a later Google trace, nor EXIF/manual photos ever", async () => {
    const gpx = await makeTrack(tripId, userId, line(10), "GPX");
    const photo = await makePhoto(tripId, userId, new Date(T0 + 4.5 * 60_000));
    const manual = await makePhoto(tripId, userId, new Date(T0 + 4.5 * 60_000), { lat: 1, lng: 2, gpsSource: "MANUAL" });
    await geotagPhotos({ tripId, trackIds: [gpx.id] });
    const google = await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lng: -70 })), "GOOGLE");
    await geotagPhotos({ tripId, trackIds: [google.id] });
    expect((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).lng).toBeCloseTo(-68, 5);
    expect((await db.photo.findUniqueOrThrow({ where: { id: manual.id } })).lng).toBe(2);
  });
});
