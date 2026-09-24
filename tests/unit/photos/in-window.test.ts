import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activityWindow, tripWindow } from "@/lib/photos/in-window";
import { resetTestDb } from "../helpers/reset";

/** What "everything taken while it was happening" offers, against a real database. */
describe("photographs taken while something was happening", () => {
  let me: { id: string; role: "ADMIN" | "MEMBER" };
  let cousin: { id: string; role: "ADMIN" | "MEMBER" };
  let acadia: { id: string; startDate: Date; endDate: Date; timezone: string };
  let other: string;
  let walk: { id: string; tripId: string; startTime: Date; endTime: Date };

  const photo = (takenAt: string, over: { tripId?: string | null; activityId?: string | null; uploaderId?: string; tzOffsetMin?: number | null; status?: "READY" | "PENDING" } = {}) =>
    db.photo.create({
      data: { uploaderId: over.uploaderId ?? me.id, tripId: over.tripId ?? null, activityId: over.activityId ?? null, takenAt: new Date(takenAt), tzOffsetMin: over.tzOffsetMin ?? null, status: over.status ?? "READY", originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1 },
      select: { id: true },
    });

  beforeEach(async () => {
    await resetTestDb();
    me = await db.user.create({ data: { email: "me@example.com", role: "MEMBER" }, select: { id: true, role: true } });
    cousin = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" }, select: { id: true, role: true } });
    acadia = await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-12"), timezone: "America/New_York", createdById: me.id }, select: { id: true, startDate: true, endDate: true, timezone: true } });
    other = (await db.trip.create({ data: { slug: "cousins", title: "The cousins' week", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-12"), createdById: cousin.id }, select: { id: true } })).id;
    walk = await db.activity.create({ data: { tripId: acadia.id, title: "Ocean Path", startTime: new Date("2025-08-11T13:00:00Z"), endTime: new Date("2025-08-11T15:00:00Z") }, select: { id: true, tripId: true, startTime: true, endTime: true } });
  });

  it("offers a walk's hours: loose ones and the trip's own, not one on another trip, which it only counts", async () => {
    const loose = await photo("2025-08-11T13:30:00Z");
    const onTrip = await photo("2025-08-11T14:00:00Z", { tripId: acadia.id });
    await photo("2025-08-11T14:10:00Z", { tripId: other });
    await photo("2025-08-11T14:20:00Z", { tripId: acadia.id, activityId: walk.id }); // already on it
    await photo("2025-08-11T16:00:00Z"); // after it ended
    await photo("2025-08-11T13:40:00Z", { status: "PENDING" }); // not ready yet
    const r = await activityWindow(me, walk);
    expect(r.ids.sort()).toEqual([loose.id, onTrip.id].sort());
    expect(r.elsewhere).toBe(1);
  });

  it("offers only a member's own, and anybody's to an admin", async () => {
    await photo("2025-08-11T13:30:00Z", { uploaderId: cousin.id });
    expect((await activityWindow(me, walk)).ids).toEqual([]);
    const admin = await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" }, select: { id: true, role: true } });
    expect((await activityWindow(admin, walk)).ids).toHaveLength(1);
  });

  it("takes a trip's days as they were where the photograph was taken, and leaves another trip's alone", async () => {
    // 01:30 UTC on the 13th is still the evening of the 12th in Maine: on the trip.
    const lateLastNight = await photo("2025-08-13T01:30:00Z");
    // 03:00 UTC on the 10th is the 9th in Maine, the day before the trip.
    await photo("2025-08-10T03:00:00Z");
    // Its own clock says +00:00, and by that it is the 13th: the day after.
    await photo("2025-08-13T01:30:00Z", { tzOffsetMin: 0 });
    await photo("2025-08-11T12:00:00Z", { tripId: other });
    await photo("2025-08-11T12:00:00Z", { tripId: acadia.id }); // already on it: not offered, not counted
    const r = await tripWindow(me, acadia);
    expect(r.ids).toEqual([lateLastNight.id]);
    expect(r.elsewhere).toBe(1);
  });
});
