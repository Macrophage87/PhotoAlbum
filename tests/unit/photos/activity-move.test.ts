import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { planDate } from "@/lib/photos/bulk-date";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { resetTestDb } from "../helpers/reset";

/**
 * What a drop on the timeline does, in the terms the actions use: an activity chosen by a person survives a clock
 * that disagrees, and a day dropped on keeps the item's time of day so the order of an afternoon holds.
 */
describe("moving an item on the timeline", () => {
  let me: string, tripId: string, walk: string, sail: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "MEMBER" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
    const at = (h: number) => new Date(Date.UTC(2025, 7, 12, h));
    walk = (await db.activity.create({ data: { tripId, title: "Morning walk", type: "HIKE", startTime: at(9), endTime: at(11) } })).id;
    sail = (await db.activity.create({ data: { tripId, title: "Evening sail", type: "BOAT", startTime: at(18), endTime: at(20) } })).id;
  });

  const photo = (iso: string) =>
    db.photo.create({ data: { tripId, uploaderId: me, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(iso), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0 } });

  it("keeps a photograph on the activity it was dropped on, though the hours say otherwise", async () => {
    // Taken during the walk, but it was the sail: two things happened that day and the clock cannot tell them apart.
    const p = await photo("2025-08-12T10:00:00Z");
    await db.photo.update({ where: { id: p.id }, data: { activityId: sail, activitySetById: me } });
    // A later date correction leaves the choice where it is.
    await applyPhotoInstant({ id: p.id, tripId, gpsSource: null, activityId: sail, activitySetById: me }, new Date("2025-08-12T10:30:00Z"), 0, "MANUAL", me, { geotag: false });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).activityId).toBe(sail);
  });

  it("re-files by the clock again once nobody's choice stands", async () => {
    const p = await photo("2025-08-12T19:00:00Z");
    await applyPhotoInstant({ id: p.id, tripId, gpsSource: null, activityId: null, activitySetById: null }, new Date("2025-08-12T19:00:00Z"), 0, "MANUAL", me, { geotag: false });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).activityId).toBe(sail);
  });

  it("drops onto a day without disturbing the time of day", () => {
    const moved = planDate({ takenAt: new Date("2025-08-12T14:30:00Z"), tzOffsetMin: 0 }, { mode: "day", day: "2025-08-14", keepTime: true }, { index: 0, fallbackOffsetMin: 0 })!;
    expect(moved.takenAt.toISOString()).toBe("2025-08-14T14:30:00.000Z");
    expect(walk).toBeTruthy();
  });
});
