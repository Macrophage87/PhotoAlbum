import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildMapPayload } from "@/lib/map/geojson";
import { OVERVIEW_POINTS, overviewLines } from "@/lib/map/overview";
import { persistTrack } from "@/lib/tracks/persist";
import { thinLine } from "@/lib/tracks/simplify";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const member: Viewer = { kind: "user", user: { id: "u", email: "m@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };

describe("track lines on the map of everything", () => {
  let tripId: string, userId: string, old: string, short: string;
  // A zigzag, so no simplification can reduce it to a straight line and every stored point matters.
  const longLine: [number, number][] = Array.from({ length: 5000 }, (_, i) => [44 + i / 1e4 + 0.123456789, -68 - (i % 2) / 1e3]);
  const shortLine: [number, number][] = [[44, -68], [44.1, -68.1], [44.2, -68.05]];
  const track = (simplified: [number, number][], overview?: [number, number][]) => db.track.create({ data: { tripId, uploaderId: userId, source: "GPX", name: "walk", startTime: new Date("2025-08-11T10:00:00Z"), endTime: new Date("2025-08-11T12:00:00Z"), pointCount: simplified.length, minLat: 44, maxLat: 45, minLng: -69, maxLng: -68, simplified, ...(overview ? { overview } : {}), pointsBlob: new Uint8Array([0]) } });
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } })).id;
    // Saved before tracks kept a short copy of their line.
    old = (await track(longLine)).id;
    short = (await track(shortLine, shortLine)).id;
  });

  it("works out a short copy of the line when a track is saved", async () => {
    const T0 = Date.parse("2025-08-12T13:00:00Z");
    const points = Array.from({ length: 20_000 }, (_, i) => ({ t: T0 + i * 1000, lat: 44 + i * 1e-5, lng: -68 + Math.sin(i / 50) * 1e-3 }));
    const saved = await persistTrack({ name: "long walk", points, sport: "HIKE" }, { tripId, userId, source: "GPX", createActivity: false });
    const row = await db.track.findUniqueOrThrow({ where: { id: saved!.trackId }, select: { simplified: true, overview: true } });
    const overview = row.overview as [number, number][];
    const simplified = row.simplified as [number, number][];
    expect(simplified.length).toBeGreaterThan(OVERVIEW_POINTS);
    expect(overview.length).toBeLessThanOrEqual(OVERVIEW_POINTS);
    expect(overview.length).toBeGreaterThan(10);
    // Both ends where they were.
    expect(overview[0]).toEqual(simplified[0]);
    expect(overview[overview.length - 1]).toEqual(simplified[simplified.length - 1]);
  });

  it("thins an older track's line when it has no short copy yet, and uses the stored one when it has", async () => {
    const rows = await db.track.findMany({ select: { id: true, overview: true } });
    const lines = await overviewLines(rows);
    const thin = lines.get(old)!;
    expect(thin).toHaveLength(OVERVIEW_POINTS);
    thinLine(longLine, OVERVIEW_POINTS).forEach(([lat, lng], i) => {
      expect(thin[i][0]).toBeCloseTo(lat, 5);
      expect(thin[i][1]).toBeCloseTo(lng, 5);
    });
    expect(lines.get(short)).toEqual(shortLine);
  });

  it("sends the short line across all trips and the whole line on the trip's own map", async () => {
    const lengthOf = (p: Awaited<ReturnType<typeof buildMapPayload>>, id: string) => p.tracks.features.find((f) => f.properties.trackId === id)!.geometry.coordinates.length;
    const everything = await buildMapPayload(member);
    expect(lengthOf(everything, old)).toBe(OVERVIEW_POINTS);
    expect(lengthOf(everything, short)).toBe(3);
    // Still longitude first, as GeoJSON wants.
    expect(everything.tracks.features.find((f) => f.properties.trackId === short)!.geometry.coordinates[1]).toEqual([-68.1, 44.1]);
    const own = await buildMapPayload(member, tripId);
    expect(lengthOf(own, old)).toBe(5000);
  });
});
