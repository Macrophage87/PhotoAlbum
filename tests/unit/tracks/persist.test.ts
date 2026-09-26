import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { persistTrack } from "@/lib/tracks/persist";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

const T0 = Date.parse("2025-08-12T14:00:00Z");
const MIN = 60_000;
// One point every 10 s, heading north at `speed` m/s.
const run = (fromMin: number, minutes: number, speed: number): TrackPoint[] =>
  Array.from({ length: minutes * 6 + 1 }, (_, i) => ({ t: T0 + fromMin * MIN + i * 10_000, lat: 44 + (i * 10 * speed) / 111_195, lng: -68 }));

describe("persistTrack", () => {
  let tripId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "p@example.com", role: "ADMIN" } });
    userId = user.id;
    tripId = (await db.trip.create({ data: { slug: "p", title: "P", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } })).id;
  });

  it("types a named sport it has no type for as OTHER, however fast it went", async () => {
    const ski = await persistTrack({ name: "Alpine_skiing", points: run(0, 20, 8), sport: null, sportRaw: "alpine_skiing" }, { tripId, userId, source: "FIT", createActivity: true });
    expect(ski?.type).toBe("OTHER");
    const unnamed = await persistTrack({ name: "Ride", points: run(30, 20, 8), sport: null }, { tripId, userId, source: "GPX", createActivity: true });
    expect(unnamed?.type).toBe("BIKE");
  });

  it("gives each leg of a multisport file an activity spanning that leg, with its own photos", async () => {
    const legs = [
      { name: "Kayaking", points: run(0, 29, 1.5), sport: "KAYAK" as const, sportRaw: "kayaking", session: { startTime: new Date(T0), endTime: new Date(T0 + 30 * MIN), distanceM: 3000 } },
      { name: "Hiking", points: run(35, 60, 1.3), sport: "HIKE" as const, sportRaw: "hiking", session: { startTime: new Date(T0 + 35 * MIN), endTime: new Date(T0 + 95 * MIN), distanceM: 5000 } },
    ];
    const photo = await db.photo.create({
      data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(T0 + 70 * MIN), takenAtSource: "EXIF_OFFSET" },
    });
    const paddle = await persistTrack(legs[0], { tripId, userId, source: "FIT", createActivity: true });
    const hike = await persistTrack(legs[1], { tripId, userId, source: "FIT", createActivity: true });
    const acts = await db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { include: { stats: true } } } });
    expect(acts.map((a) => [a.type, a.startTime.getTime(), a.endTime.getTime(), a.track?.stats?.distanceM])).toEqual([
      ["KAYAK", T0, T0 + 30 * MIN, 3000],
      ["HIKE", T0 + 35 * MIN, T0 + 95 * MIN, 5000],
    ]);
    expect(paddle?.activityId).toBe(acts[0].id);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).activityId).toBe(hike?.activityId);
  });
});
