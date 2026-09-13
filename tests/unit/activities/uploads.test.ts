import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { resetTestDb } from "../helpers/reset";

const hour = (h: number) => new Date(Date.UTC(2025, 7, 12, h));

describe("photos put on an activity by a member", () => {
  let me: string, tripId: string, walkId: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
    walkId = (await db.activity.create({ data: { tripId, title: "Morning walk", type: "HIKE", startTime: hour(9), endTime: hour(11) } })).id;
  });

  const photo = (name: string, takenAt: Date | null, setBy: string | null) =>
    db.photo.create({
      data: { tripId, activityId: walkId, activitySetById: setBy, uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt, takenAtSource: takenAt ? "EXIF_OFFSET" : null, tzOffsetMin: takenAt ? 0 : null },
    });

  it("keeps a scan with no date on the activity, where the time window would have thrown it out", async () => {
    const scan = await photo("scan.jpg", null, me);
    const stray = await photo("stray.jpg", null, null);
    await reassignPhotosForActivity(walkId);
    expect((await db.photo.findUniqueOrThrow({ where: { id: scan.id } })).activityId).toBe(walkId);
    // One the album filed by time is still governed by the time: it has no date, so it goes.
    expect((await db.photo.findUniqueOrThrow({ where: { id: stray.id } })).activityId).toBeNull();
  });

  it("keeps one taken before the walk set off, and still takes back one that only fell out by minutes", async () => {
    const early = await photo("before.jpg", hour(7), me);
    const drifted = await photo("after.jpg", hour(12), null);
    await reassignPhotosForActivity(walkId);
    expect((await db.photo.findUniqueOrThrow({ where: { id: early.id } })).activityId).toBe(walkId);
    expect((await db.photo.findUniqueOrThrow({ where: { id: drifted.id } })).activityId).toBeNull();
  });

  it("attaches an unassigned photo taken during the activity, as it always did", async () => {
    const loose = await db.photo.create({ data: { tripId, uploaderId: me, originalName: "loose.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: hour(10), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0 } });
    await reassignPhotosForActivity(walkId);
    expect((await db.photo.findUniqueOrThrow({ where: { id: loose.id } })).activityId).toBe(walkId);
  });

  it("does not move a member's choice when the date is corrected", async () => {
    const other = await db.activity.create({ data: { tripId, title: "Evening sail", type: "BOAT", startTime: hour(18), endTime: hour(20) } });
    const scan = await photo("scan.jpg", null, me);
    // The date turns out to be during the evening sail; the walk is still where it was filed.
    await applyPhotoInstant({ id: scan.id, tripId, gpsSource: null, activityId: walkId, activitySetById: me }, hour(19), 0, "MANUAL", me, { geotag: false });
    expect((await db.photo.findUniqueOrThrow({ where: { id: scan.id } })).activityId).toBe(walkId);

    // Where nobody chose, the corrected date decides.
    const auto = await photo("auto.jpg", hour(10), null);
    await applyPhotoInstant({ id: auto.id, tripId, gpsSource: null, activityId: walkId, activitySetById: null }, hour(19), 0, "MANUAL", me, { geotag: false });
    expect((await db.photo.findUniqueOrThrow({ where: { id: auto.id } })).activityId).toBe(other.id);
  });
});
