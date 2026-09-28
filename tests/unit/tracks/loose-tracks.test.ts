import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { deleteLooseTrack } from "@/app/trips/[slug]/import/actions";

const T0 = Date.parse("2025-08-12T13:00:00Z");

/** A track left behind by "Delete activity" without its track can be deleted on its own, by whoever arranges the trip. */
describe("deleting a track no activity holds", () => {
  let owner: string, member: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    owner = (await db.user.create({ data: { email: "owner@example.com" } })).id;
    member = (await db.user.create({ data: { email: "member@example.com" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: owner } })).id;
    who.id = owner;
    who.role = "MEMBER";
  });
  const track = async () => {
    const { blob, startTime, endTime } = encodePoints([{ t: T0, lat: 44, lng: -68 }, { t: T0 + 60_000, lat: 44.001, lng: -68 }]);
    return db.track.create({ data: { tripId, uploaderId: owner, source: "GPX", name: "Ride", startTime, endTime, pointCount: 2, minLat: 44, maxLat: 44.001, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) } });
  };

  it("deletes it, and takes back the place it gave a photo", async () => {
    const bare = await track();
    const photo = await db.photo.create({ data: { tripId, uploaderId: owner, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(T0 + 30_000), takenAtSource: "EXIF_OFFSET", lat: 44.0005, lng: -68, gpsSource: "TRACK" } });
    await deleteLooseTrack("acadia", bare.id);
    expect(await db.track.count()).toBe(0);
    expect(await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ lat: null, gpsSource: null });
  });

  it("leaves an activity's track to the activity, and refuses anyone but the trip's maker or an admin", async () => {
    const held = await track();
    await db.activity.create({ data: { tripId, title: "Ride", type: "BIKE", startTime: held.startTime, endTime: held.endTime, trackId: held.id } });
    await deleteLooseTrack("acadia", held.id);
    expect(await db.track.count()).toBe(1);

    const bare = await track();
    who.id = member;
    await expect(deleteLooseTrack("acadia", bare.id)).rejects.toThrow();
    expect(await db.track.count()).toBe(2);
    who.role = "ADMIN";
    await deleteLooseTrack("acadia", bare.id);
    expect(await db.track.count()).toBe(1);
  });
});
