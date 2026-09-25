import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activityCover } from "@/lib/activities/cover";
import { resetTestDb } from "../helpers/reset";

/** Which photograph an activity is fronted by, against a real database. */
describe("an activity's cover", () => {
  let walk: { id: string; coverPhotoId: string | null };
  let uploaderId: string;

  const photo = (takenAt: string, over: { activityId?: string | null; trashed?: boolean; status?: "READY" | "PENDING" } = {}) =>
    db.photo.create({
      data: { uploaderId, activityId: over.activityId === undefined ? walk.id : over.activityId, takenAt: new Date(takenAt), status: over.status ?? "READY", trashedAt: over.trashed ? new Date() : null, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1 },
      select: { id: true },
    });
  const choose = async (id: string | null) => {
    await db.activity.update({ where: { id: walk.id }, data: { coverPhotoId: id } });
    walk = { ...walk, coverPhotoId: id };
  };

  beforeEach(async () => {
    await resetTestDb();
    uploaderId = (await db.user.create({ data: { email: "me@example.com" }, select: { id: true } })).id;
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-12"), createdById: uploaderId }, select: { id: true } });
    walk = await db.activity.create({ data: { tripId: trip.id, title: "Walk", startTime: new Date("2025-08-11T13:00:00Z"), endTime: new Date("2025-08-11T15:00:00Z") }, select: { id: true, coverPhotoId: true } });
  });

  it("is the first photograph taken on it, when none has been chosen", async () => {
    await photo("2025-08-11T14:00:00Z");
    const first = await photo("2025-08-11T13:10:00Z");
    await photo("2025-08-11T13:05:00Z", { status: "PENDING" });
    expect((await activityCover(walk))?.id).toBe(first.id);
  });

  it("is the one chosen, while it is still one of the activity's own finished photographs", async () => {
    const first = await photo("2025-08-11T13:10:00Z");
    const later = await photo("2025-08-11T14:00:00Z");
    await choose(later.id);
    expect((await activityCover(walk))?.id).toBe(later.id);
    // Taken off the activity: the first one again.
    await db.photo.update({ where: { id: later.id }, data: { activityId: null } });
    expect((await activityCover(walk))?.id).toBe(first.id);
    // Back on it, but in the trash: still the first one.
    await db.photo.update({ where: { id: later.id }, data: { activityId: walk.id, trashedAt: new Date() } });
    expect((await activityCover(walk))?.id).toBe(first.id);
  });

  it("is nothing when the activity has no photographs", async () => {
    expect(await activityCover(walk)).toBeNull();
  });
});
