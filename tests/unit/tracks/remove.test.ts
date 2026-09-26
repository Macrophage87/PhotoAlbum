import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));

import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { deleteTrackAndItsPositions } from "@/lib/tracks/remove";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

const T0 = Date.parse("2025-08-12T13:00:00Z");
const line = (n: number, lat0: number): TrackPoint[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 60_000, lat: lat0 + i * 0.001, lng: -68 }));

describe("deleteTrackAndItsPositions", () => {
  let tripId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    const user = await db.user.create({ data: { email: "r@example.com", role: "ADMIN" } });
    userId = user.id;
    tripId = (await db.trip.create({ data: { slug: "r", title: "R", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } })).id;
  });

  async function track(points: TrackPoint[], source: "GPX" | "GOOGLE") {
    const { blob, startTime, endTime } = encodePoints(points);
    return db.track.create({
      data: { tripId, uploaderId: userId, source, name: source, startTime, endTime, pointCount: points.length, minLat: 44, maxLat: 51, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) },
    });
  }
  const photo = (minutes: number, extra: Record<string, unknown> = {}) =>
    db.photo.create({
      data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(T0 + minutes * 60_000), takenAtSource: "EXIF_OFFSET", ...extra },
    });

  it("takes back the positions the track gave, and lets the remaining tracks place them again", async () => {
    await track(line(10, 50), "GOOGLE");
    const wrong = await track(line(10, 44), "GPX");
    const placed = await photo(3);
    const exif = await photo(4, { lat: 1, lng: 2, gpsSource: "EXIF" });
    const later = await photo(60, { lat: 7, lng: 8, gpsSource: "TRACK" });
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: placed.id } })).lat).toBeCloseTo(44.003, 5);

    await deleteTrackAndItsPositions(wrong.id);
    expect(await db.track.findUnique({ where: { id: wrong.id } })).toBeNull();
    // Placed again straight away from the Google trace that still covers the moment.
    const moved = await db.photo.findUniqueOrThrow({ where: { id: placed.id } });
    expect([moved.gpsSource, moved.lat]).toEqual(["TRACK", expect.closeTo(50.003, 5)]);
    // A camera's own position, and a track position from outside the deleted track's hours, are left alone.
    expect((await db.photo.findUniqueOrThrow({ where: { id: exif.id } })).gpsSource).toBe("EXIF");
    expect((await db.photo.findUniqueOrThrow({ where: { id: later.id } })).lat).toBe(7);
    expect(enqueued).toEqual([]);
  });

  it("clears a position no remaining track covers, and leaves other trips alone", async () => {
    const wrong = await track(line(10, 44), "GPX");
    const placed = await photo(3);
    const otherTrip = await db.trip.create({ data: { slug: "o", title: "O", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } });
    const elsewhere = await photo(3, { tripId: otherTrip.id, lat: 30, lng: 31, gpsSource: "TRACK" });
    await geotagPhotos({ tripId });

    await deleteTrackAndItsPositions(wrong.id);
    const cleared = await db.photo.findUniqueOrThrow({ where: { id: placed.id } });
    expect([cleared.lat, cleared.gpsSource]).toEqual([null, null]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: elsewhere.id } })).lat).toBe(30);
  });

  it("a geotag run that read the track before it was deleted writes nothing from it", async () => {
    await track(line(10, 44), "GPX");
    const stale = await db.track.findMany({ where: { tripId } });
    const p = await photo(3);
    await db.track.deleteMany({ where: { tripId } });
    const spy = vi.spyOn(db.track, "findMany").mockResolvedValueOnce(stale as never);
    try {
      expect((await geotagPhotos({ tripId })).updated).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).lat).toBeNull();
  });

  it("does nothing for a track that is already gone", async () => {
    await deleteTrackAndItsPositions("missing");
    expect(enqueued).toEqual([]);
  });
});
