import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("replaces a place the helper guessed at, since a track is a record and a guess is not", async () => {
    await makeTrack(tripId, userId, line(10), "GPX");
    const guessed = await makePhoto(tripId, userId, new Date(T0 + 4.5 * 60_000), { lat: 41.9, lng: 12.45, gpsSource: "ESTIMATE", placeEstimateName: "St Peter's Square", placeEstimatedAt: new Date() });

    expect((await geotagPhotos({ tripId })).updated).toBe(1);
    const p = await db.photo.findUniqueOrThrow({ where: { id: guessed.id } });
    expect(p.gpsSource).toBe("TRACK");
    expect(p.lat).toBeCloseTo(44.0045, 4);
    // The item has been asked about, so a later place backfill leaves it alone whatever happens to this position.
    expect(p.placeEstimatedAt).not.toBeNull();
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

  it("prefers the photographer's own Google trace over another member's", async () => {
    const other = await db.user.create({ data: { email: "o@example.com", role: "MEMBER" } });
    await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: 50 })), "GOOGLE");
    await makeTrack(tripId, other.id, line(10).map((p) => ({ ...p, lat: 60 })), "GOOGLE");
    const theirs = await makePhoto(tripId, other.id, new Date(T0 + 3 * 60_000));
    const mine = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: theirs.id } })).lat).toBe(60);
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBe(50);
  });

  it("prefers the photographer's own Google trace over another member's activity track", async () => {
    const dad = await db.user.create({ data: { email: "dad@example.com", role: "MEMBER" } });
    await makeTrack(tripId, dad.id, line(10), "GPX");
    await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: 50 })), "GOOGLE");
    const mine = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    const his = await makePhoto(tripId, dad.id, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBe(50);
    expect((await db.photo.findUniqueOrThrow({ where: { id: his.id } })).lat).toBeCloseTo(44.003, 5);
  });

  it("keeps a photo on another member's activity track when the uploader's own trace puts them together", async () => {
    const dad = await db.user.create({ data: { email: "dad2@example.com", role: "MEMBER" } });
    await makeTrack(tripId, dad.id, line(10), "GPX");
    const mine = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBeCloseTo(44.003, 5);
    // Her own coarse trace, about 110 m off his: they were walking together, and his track is the precise one.
    const own = await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: p.lat + 0.001 })), "GOOGLE");
    await geotagPhotos({ tripId, trackIds: [own.id] });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBeCloseTo(44.003, 5);
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBeCloseTo(44.003, 5);
  });

  it("moves a photo onto the uploader's own trace when it puts them apart from another member's activity track", async () => {
    const dad = await db.user.create({ data: { email: "dad3@example.com", role: "MEMBER" } });
    await makeTrack(tripId, dad.id, line(10), "GPX");
    const mine = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    // Her own trace is a few kilometres away: she was not on his ride.
    const own = await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: p.lat + 0.05 })), "GOOGLE");
    await geotagPhotos({ tripId, trackIds: [own.id] });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBeCloseTo(44.053, 5);
  });

  describe("when the uploader's own trace and another member's activity track disagree", () => {
    let dadId: string;
    beforeEach(async () => {
      dadId = (await db.user.create({ data: { email: "dad4@example.com", role: "MEMBER" } })).id;
      await makeTrack(tripId, dadId, line(40), "GPX");
    });
    const latOf = async (id: string) => (await db.photo.findUniqueOrThrow({ where: { id } })).lat;

    it("keeps the activity track when the trace only snaps across a signal gap (D)", async () => {
      // Her trace has fixes at 13:00 and 13:30 only; at 13:04 it snaps back to 13:00, ~800 m behind his.
      await makeTrack(tripId, userId, [{ t: T0, lat: 43.997, lng: -68 }, { t: T0 + 30 * 60_000, lat: 44.03, lng: -68 }], "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 4 * 60_000));
      await geotagPhotos({ tripId });
      expect(await latOf(mine.id)).toBeCloseTo(44.004, 5);
    });

    it("keeps the activity track when the trace there is only filled in across a visit (B)", async () => {
      // A big park recorded as a visit: filler every 5 minutes at its centre, 2 km off the trail.
      await makeTrack(tripId, userId, Array.from({ length: 7 }, (_, i) => ({ t: T0 + i * 5 * 60_000, lat: 44.02, lng: -68, filled: "visit" as const })), "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 12 * 60_000));
      await geotagPhotos({ tripId });
      expect(await latOf(mine.id)).toBeCloseTo(44.012, 5);
    });

    it("follows the uploader's own visit when it is kilometres from the activity track (museum)", async () => {
      // Three hours in a museum, nothing recorded but the visit, 9 km from Dad's ride.
      await makeTrack(tripId, userId, Array.from({ length: 37 }, (_, i) => ({ t: T0 + i * 5 * 60_000, lat: 44.081, lng: -68, filled: "visit" as const })), "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 12 * 60_000));
      await geotagPhotos({ tripId });
      expect(await latOf(mine.id)).toBe(44.081);
    });

    it("follows the uploader's own visit when she was apart from him at its doors, though its centre is near his route (F)", async () => {
      // Dad rides north for four hours. Mom walks to a museum 2 km east of where he will be at 14:40, stays three
      // hours with nothing recorded but the visit, and walks off. At both doors he is kilometres away.
      await makeTrack(tripId, dadId, line(240), "GPX");
      const east = (m: number) => -68 + m / (111_195 * Math.cos((44.1 * Math.PI) / 180));
      const museum = { lat: 44.1, lng: east(2_000) };
      await makeTrack(tripId, userId, [
        ...Array.from({ length: 11 }, (_, i) => ({ t: T0 + i * 60_000, ...museum })),
        ...Array.from({ length: 37 }, (_, i) => ({ t: T0 + (15 + i * 5) * 60_000, ...museum, filled: "visit" as const })),
        ...Array.from({ length: 10 }, (_, i) => ({ t: T0 + (200 + i) * 60_000, ...museum })),
      ], "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 100 * 60_000));
      await geotagPhotos({ tripId });
      const p = await db.photo.findUniqueOrThrow({ where: { id: mine.id } });
      expect([p.lat, p.lng]).toEqual([museum.lat, expect.closeTo(museum.lng, 6)]);
    });

    it("keeps the activity track when she was with him at the doors of a huge park whose centre is far off (B, doors)", async () => {
      await makeTrack(tripId, dadId, line(240), "GPX");
      const east = (m: number) => -68 + m / (111_195 * Math.cos((44 * Math.PI) / 180));
      // Her recorded fixes follow his trail up to 13:10 and again from 14:00; in between, the park's centre 3.5 km east.
      await makeTrack(tripId, userId, [
        ...line(11),
        ...Array.from({ length: 9 }, (_, i) => ({ t: T0 + (15 + i * 5) * 60_000, lat: 44.03, lng: east(3_500), filled: "visit" as const })),
        ...line(10, 60),
      ], "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 30 * 60_000));
      await geotagPhotos({ tripId });
      expect(await latOf(mine.id)).toBeCloseTo(44.03, 5);
      expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lng).toBe(-68);
    });

    for (const km of [1, 5]) {
      it(`follows her own trace logged every 8 minutes when it is ${km} km from his (A)`, async () => {
        const east = -68 + (km * 1000) / (111_195 * Math.cos((44 * Math.PI) / 180));
        await makeTrack(tripId, userId, Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * 8 * 60_000, lat: 44 + i * 0.008, lng: east })), "GOOGLE");
        const mine = await makePhoto(tripId, userId, new Date(T0 + 12 * 60_000));
        await geotagPhotos({ tripId });
        const p = await db.photo.findUniqueOrThrow({ where: { id: mine.id } });
        expect(p.lng).toBeCloseTo(east, 6);
      });
    }

    it("chooses the member she was with when two others' activity tracks cover the moment (C)", async () => {
      const son = (await db.user.create({ data: { email: "son@example.com", role: "MEMBER" } })).id;
      // Dad is 5 km away; her own trace and Son's track are within 100 m of each other.
      await makeTrack(tripId, son, line(40).map((p) => ({ ...p, lat: p.lat + 0.045 })), "GPX");
      await makeTrack(tripId, userId, line(40).map((p) => ({ ...p, lat: p.lat + 0.0455 })), "GOOGLE");
      const mine = await makePhoto(tripId, userId, new Date(T0 + 4 * 60_000));
      await geotagPhotos({ tripId });
      expect(await latOf(mine.id)).toBeCloseTo(44.049, 5);
    });
  });

  it("moves a photo onto its photographer's own Google trace imported after someone else's", async () => {
    const other = await db.user.create({ data: { email: "o2@example.com", role: "MEMBER" } });
    await makeTrack(tripId, other.id, line(10).map((p) => ({ ...p, lat: 60 })), "GOOGLE");
    const mine = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    await geotagPhotos({ tripId });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBe(60);
    const own = await makeTrack(tripId, userId, line(10).map((p) => ({ ...p, lat: 50 })), "GOOGLE");
    await geotagPhotos({ tripId, trackIds: [own.id] });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBe(50);
    // Another member's new trace does not pull it back.
    const again = await makeTrack(tripId, other.id, line(10).map((p) => ({ ...p, lat: 70 })), "GOOGLE");
    await geotagPhotos({ tripId, trackIds: [again.id] });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine.id } })).lat).toBe(50);
  });

  it("never overwrites a place a member set by hand while the run was working", async () => {
    await makeTrack(tripId, userId, line(10), "GPX");
    const photo = await makePhoto(tripId, userId, new Date(T0 + 3 * 60_000));
    const read = db.photo.findMany.bind(db.photo);
    const spy = vi.spyOn(db.photo, "findMany").mockImplementationOnce((async (args: never) => {
      const found = await read(args);
      await db.photo.update({ where: { id: photo.id }, data: { lat: 1, lng: 2, gpsSource: "MANUAL" } });
      return found;
    }) as never);
    try {
      expect((await geotagPhotos({ tripId })).updated).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const p = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect([p.gpsSource, p.lat]).toEqual(["MANUAL", 1]);
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
