import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import { positionKindAt } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

// The visit rule needs a visit point at or just after the photo's moment. The real positionKindAt only says "visit"
// where there is one, so to reach the case where there is none it is made to say "visit" everywhere here.
vi.mock("@/lib/tracks/interpolate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracks/interpolate")>();
  return { ...actual, positionKindAt: vi.fn(actual.positionKindAt) };
});

const T0 = Date.parse("2025-08-12T13:00:00Z");
const M = 60_000;
const at = (t: number, lat: number): TrackPoint => ({ t, lat, lng: -68 });

async function makeTrack(tripId: string, userId: string, points: TrackPoint[], source: "GPX" | "GOOGLE") {
  const { blob, startTime, endTime } = encodePoints(points);
  return db.track.create({
    data: { tripId, uploaderId: userId, source, name: source, startTime, endTime, pointCount: points.length, minLat: 44, maxLat: 45, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) },
  });
}

async function makePhoto(tripId: string, userId: string, takenAt: Date) {
  return db.photo.create({
    data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt, takenAtSource: "EXIF_OFFSET" },
  });
}

describe("geotagPhotos, a visit position with no visit point beside it", () => {
  let tripId: string, momId: string, dadId: string;
  beforeEach(async () => {
    await resetTestDb();
    vi.mocked(positionKindAt).mockReturnValue("visit");
    momId = (await db.user.create({ data: { email: "mom@example.com", role: "ADMIN" } })).id;
    dadId = (await db.user.create({ data: { email: "dad@example.com", role: "MEMBER" } })).id;
    tripId = (await db.trip.create({ data: { slug: "v", title: "V", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: momId } })).id;
  });

  it("at the last point of her trace: judged as a guess rather than read past the end", async () => {
    await makeTrack(tripId, momId, Array.from({ length: 10 }, (_, i) => at(T0 - (9 - i) * M, 44)), "GOOGLE");
    // Dad's ride, about 1 km north of her the whole time: near enough for a guess to defer to.
    await makeTrack(tripId, dadId, Array.from({ length: 21 }, (_, i) => at(T0 + (i - 10) * M, 44.009)), "GPX");
    const photo = await makePhoto(tripId, momId, new Date(T0));

    expect((await geotagPhotos({ tripId })).updated).toBe(1);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).lat).toBeCloseTo(44.009, 6);
  });

  it("between two recorded points: judged as a guess, not by the visit rule around a point that is no visit's place", async () => {
    // Her trace: recorded at A until the photo, then at P, about 5.5 km north, ten minutes on.
    const mom = [...Array.from({ length: 11 }, (_, i) => at(T0 - (10 - i) * M, 44)), ...Array.from({ length: 11 }, (_, i) => at(T0 + (10 + i) * M, 44.05))];
    await makeTrack(tripId, momId, mom, "GOOGLE");
    // Dad waits at P throughout. The visit rule would take P for her visit's place and put the photo on his track;
    // as a guess, she is 5.5 km from him, too far to defer to.
    await makeTrack(tripId, dadId, Array.from({ length: 31 }, (_, i) => at(T0 + (i - 10) * M, 44.05)), "GPX");
    const photo = await makePhoto(tripId, momId, new Date(T0 + 10_000));

    expect((await geotagPhotos({ tripId })).updated).toBe(1);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).lat).toBeCloseTo(44 + 0.05 / 60, 6);
  });
});
