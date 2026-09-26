import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import { storage } from "@/lib/storage";
import { importTrackFile } from "@/lib/tracks/import";
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

  describe("whether the uploader was with another member, from a Google Timeline export imported end to end", () => {
    const M = 60_000;
    const E = (m: number) => m / (111_195 * Math.cos((44 * Math.PI) / 180)); // degrees of longitude per metre east
    const N = (m: number) => m / 111_195;
    const iso = (ms: number) => new Date(ms).toISOString();
    // Dad's GPX: one fix a minute, heading north from (44, -68 + east) at `perMin` metres a minute.
    const dadAt = (min: number, perMin: number, east = 0) => ({ lat: 44 + N(min * perMin), lng: -68 + E(east) });
    const dadTrack = (userId: string, minutes: number, perMin: number, east = 0) =>
      makeTrack(tripId, userId, Array.from({ length: minutes + 1 }, (_, i) => ({ t: T0 + i * M, ...dadAt(i, perMin, east) })), "GPX");
    type LL = { lat: number; lng: number };
    const geo = (p: LL) => `geo:${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
    const recorded = (fixes: [number, LL][]) => ({ startTime: iso(fixes[0][0]), endTime: iso(fixes[fixes.length - 1][0]), timelinePath: fixes.map(([t, p]) => ({ point: geo(p), time: iso(t) })) });
    const visit = (from: number, to: number, p: LL) => ({ startTime: iso(from), endTime: iso(to), visit: { probability: 0.9, topCandidate: { placeLocation: { latLng: `${p.lat.toFixed(7)}°, ${p.lng.toFixed(7)}°` } } } });
    const move = (from: number, to: number, a: LL, b: LL) => ({ startTime: iso(from), endTime: iso(to), activity: { start: { latLng: `${a.lat.toFixed(7)}°, ${a.lng.toFixed(7)}°` }, end: { latLng: `${b.lat.toFixed(7)}°, ${b.lng.toFixed(7)}°` } } });
    // Mom's Timeline.json goes through the real import: parse, fill visits, split into days, encode, store.
    const importTimeline = async (userId: string, segments: unknown[]) => {
      const key = `imports/test/${Math.random().toString(36).slice(2)}.json`;
      const file = storage().localPath!(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ semanticSegments: segments }));
      const summary = await importTrackFile({ importKey: key, tripId, userId, sourceHint: "google", originalName: "Timeline.json" });
      expect(summary.tracks.length).toBeGreaterThan(0);
    };
    const placed = async (id: string) => {
      const p = await db.photo.findUniqueOrThrow({ where: { id } });
      return { lat: p.lat!, lng: p.lng! };
    };
    let dadId: string;
    beforeEach(async () => {
      dadId = (await db.user.create({ data: { email: "dad@example.com", role: "MEMBER" } })).id;
    });

    it("apart: a museum 8 km from Dad's ride", async () => {
      await dadTrack(dadId, 240, 300);
      const museum = { lat: dadAt(110, 300).lat, lng: -68 + E(8_000) };
      await importTimeline(userId, [move(T0, T0 + 20 * M, dadAt(0, 300), museum), visit(T0 + 20 * M, T0 + 200 * M, museum), move(T0 + 200 * M, T0 + 220 * M, museum, dadAt(0, 300))]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 110 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lng).toBeCloseTo(museum.lng, 6);
    });

    it("together: hiking with Dad through a park whose centre is 2 km off the trail", async () => {
      await dadTrack(dadId, 240, 60);
      const along = (from: number, to: number) => recorded(Array.from({ length: (to - from) / 2 + 1 }, (_, k) => [T0 + (from + 2 * k) * M, dadAt(from + 2 * k, 60)] as [number, LL]));
      await importTimeline(userId, [along(0, 20), visit(T0 + 20 * M, T0 + 120 * M, { lat: dadAt(70, 60).lat, lng: -68 + E(2_000) }), along(120, 140)]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 70 * M));
      await geotagPhotos({ tripId });
      expect(await placed(photo.id)).toEqual({ lat: expect.closeTo(dadAt(70, 60).lat, 6), lng: -68 });
    });

    it("apart: a hotel 80 km away, its doors hours from the photo", async () => {
      await dadTrack(dadId, 600, 300);
      const hotel = { lat: 44, lng: -68 + E(80_000) };
      await importTimeline(userId, [move(T0 - 150 * M, T0 - 120 * M, { lat: 44.1, lng: hotel.lng }, hotel), visit(T0 - 120 * M, T0 + 630 * M, hotel), move(T0 + 630 * M, T0 + 650 * M, hotel, { lat: 44.1, lng: hotel.lng })]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 300 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lng).toBeCloseTo(hotel.lng, 6);
    });

    it("apart: arrived somewhere together, and Dad rode on 6 km before the photo", async () => {
      await dadTrack(dadId, 300, 43);
      const spot = dadAt(20, 43);
      const along = recorded(Array.from({ length: 11 }, (_, k) => [T0 + 2 * k * M, dadAt(2 * k, 43)] as [number, LL]));
      await importTimeline(userId, [along, visit(T0 + 20 * M, T0 + 170 * M, spot), move(T0 + 170 * M, T0 + 190 * M, spot, dadAt(0, 43))]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 160 * M));
      await geotagPhotos({ tripId });
      expect(await placed(photo.id)).toEqual({ lat: expect.closeTo(spot.lat, 6), lng: expect.closeTo(spot.lng, 6) });
    });

    it("apart: her trace only snaps across a signal gap, but Dad is 50 km away", async () => {
      await dadTrack(dadId, 60, 300);
      const far = (min: number) => ({ lat: dadAt(min, 300).lat, lng: -68 + E(50_000) });
      await importTimeline(userId, [recorded([[T0, far(0)], [T0 + 40 * M, far(40)]])]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 4 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lng).toBeCloseTo(far(0).lng, 6);
    });

    for (const [east, apart] of [[1_000, true], [100, false]] as const) {
      it(`${apart ? "apart" : "together"}: her own recorded path ${east} m from Dad's`, async () => {
        await dadTrack(dadId, 60, 300);
        const hers = (min: number) => ({ lat: dadAt(min, 300).lat, lng: -68 + E(east) });
        await importTimeline(userId, [recorded(Array.from({ length: 31 }, (_, k) => [T0 + 2 * k * M, hers(2 * k)] as [number, LL]))]);
        const photo = await makePhoto(tripId, userId, new Date(T0 + 31 * M));
        await geotagPhotos({ tripId });
        expect((await placed(photo.id)).lng).toBeCloseTo(apart ? hers(31).lng : -68, 6);
      });
    }

    const dadRoute = (userId: string, minutes: number, where: (min: number) => LL) =>
      makeTrack(tripId, userId, Array.from({ length: minutes + 1 }, (_, i) => ({ t: T0 + i * M, ...where(i) })), "GPX");

    it("apart: breakfast together at the hotel, then Mom's museum 5 km east while Dad rides 86 km north (G)", async () => {
      const hotel = { lat: 44, lng: -68 };
      await dadRoute(dadId, 240, (i) => (i <= 60 ? hotel : { lat: 44 + N(Math.min(86_000, (i - 60) * 500)), lng: -68 }));
      const museum = { lat: 44, lng: -68 + E(5_000) };
      await importTimeline(userId, [visit(T0, T0 + 60 * M, hotel), move(T0 + 60 * M, T0 + 80 * M, hotel, museum), visit(T0 + 80 * M, T0 + 240 * M, museum)]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 200 * M));
      await geotagPhotos({ tripId });
      expect(await placed(photo.id)).toEqual({ lat: 44, lng: expect.closeTo(museum.lng, 6) });
    });

    it("apart: arrived at a park together, Dad rode 20 km east after half an hour, photo two hours on (I)", async () => {
      const park = dadAt(20, 60);
      await dadRoute(dadId, 200, (i) => (i <= 20 ? dadAt(i, 60) : i <= 50 ? park : { lat: park.lat, lng: park.lng + E(Math.min(20_000, (i - 50) * 330)) }));
      await importTimeline(userId, [recorded(Array.from({ length: 11 }, (_, k) => [T0 + 2 * k * M, dadAt(2 * k, 60)] as [number, LL])), visit(T0 + 20 * M, T0 + 200 * M, park)]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 140 * M));
      await geotagPhotos({ tripId });
      expect(await placed(photo.id)).toEqual({ lat: expect.closeTo(park.lat, 6), lng: expect.closeTo(park.lng, 6) });
    });

    it("apart, by accepted trade-off: a park whose centre is 3.9 km from Dad at the moment goes to its centre (B2)", async () => {
      await dadTrack(dadId, 240, 60);
      const centre = { lat: dadAt(70, 60).lat, lng: -68 + E(3_900) };
      const along = (from: number, to: number) => recorded(Array.from({ length: (to - from) / 2 + 1 }, (_, k) => [T0 + (from + 2 * k) * M, dadAt(from + 2 * k, 60)] as [number, LL]));
      await importTimeline(userId, [along(0, 20), visit(T0 + 20 * M, T0 + 120 * M, centre), along(120, 140)]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 70 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lng).toBeCloseTo(centre.lng, 6);
    });

    it("together: with Son rather than Dad, when both ride and Son is the one beside her (C)", async () => {
      const son = (await db.user.create({ data: { email: "son@example.com", role: "MEMBER" } })).id;
      await dadTrack(dadId, 60, 300, 5_000);
      await dadTrack(son, 60, 300);
      await importTimeline(userId, [recorded(Array.from({ length: 31 }, (_, k) => [T0 + 2 * k * M, { lat: dadAt(2 * k, 300).lat, lng: -68 + E(100) }] as [number, LL]))]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 31 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lng).toBeCloseTo(-68, 6);
    });

    it("together: her trace snaps across a signal gap to a point a kilometre behind Dad on his route (D)", async () => {
      await dadTrack(dadId, 60, 300);
      await importTimeline(userId, [recorded([[T0, dadAt(0, 300)], [T0 + 30 * M, dadAt(30, 300)]])]);
      const photo = await makePhoto(tripId, userId, new Date(T0 + 4 * M));
      await geotagPhotos({ tripId });
      expect((await placed(photo.id)).lat).toBeCloseTo(dadAt(4, 300).lat, 6);
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
