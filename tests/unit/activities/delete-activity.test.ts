import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
const removed = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "a@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
vi.mock("@/lib/tracks/remove", () => ({ deleteTrackAndItsPositions: async (id: string) => { removed.push(id); } }));

import { deleteActivity } from "@/app/trips/[slug]/activities/actions";

describe("deleteActivity", () => {
  let activityId: string, trackId: string;
  beforeEach(async () => {
    await resetTestDb();
    removed.length = 0;
    const user = await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } });
    who.id = user.id;
    const trip = await db.trip.create({ data: { slug: "d", title: "D", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const t = new Date("2025-08-12T13:00:00Z");
    trackId = (await db.track.create({ data: { tripId: trip.id, uploaderId: user.id, source: "GPX", name: "t", startTime: t, endTime: t, pointCount: 0, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array() } })).id;
    activityId = (await db.activity.create({ data: { tripId: trip.id, title: "Walk", type: "HIKE", startTime: t, endTime: t, trackId } })).id;
  });

  it("takes its track, and the positions it gave, when asked to", async () => {
    const fd = new FormData();
    fd.set("deleteTrack", "on");
    await expect(deleteActivity("d", activityId, fd)).rejects.toThrow(/REDIRECT/);
    expect(removed).toEqual([trackId]);
  });

  it("keeps the track otherwise", async () => {
    await expect(deleteActivity("d", activityId, new FormData())).rejects.toThrow(/REDIRECT/);
    expect(removed).toEqual([]);
    expect(await db.track.count()).toBe(1);
  });
});
