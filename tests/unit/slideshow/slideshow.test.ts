import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { collectionSlides, tripSlides } from "@/lib/photos/slideshow";
import { step } from "@/components/slideshow/Slideshow";
import { resetTestDb } from "../helpers/reset";

describe("moving through a slideshow", () => {
  it("goes round again at either end", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(0, -1, 3)).toBe(2);
    expect(step(0, 1, 0)).toBe(0);
  });
});

describe("what a slideshow shows", () => {
  let userId: string, tripId: string;
  let mk: (name: string, extra?: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "jo@example.com", name: "Jo" } })).id;
    tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId, timezone: "America/New_York" } })).id;
    mk = async (name, extra = {}) =>
      (await db.photo.create({ data: { tripId, uploaderId: userId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 80, ...extra } })).id;
  });

  it("is a trip's finished photographs in the order the trip happened, the undated last", async () => {
    const undated = await mk("undated");
    const second = await mk("second", { takenAt: new Date("2025-08-12T15:00:00Z") });
    const first = await mk("first", { takenAt: new Date("2025-08-11T15:00:00Z"), caption: " Low tide ", placeName: "Pemaquid Point" });
    await mk("clip", { kind: "VIDEO", takenAt: new Date("2025-08-11T16:00:00Z") });
    await mk("busy", { status: "PROCESSING", takenAt: new Date("2025-08-11T16:00:00Z") });
    await mk("gone", { trashedAt: new Date(), takenAt: new Date("2025-08-11T16:00:00Z") });
    const slides = await tripSlides(tripId, false);
    expect(slides.map((s) => s.id)).toEqual([first, second, undated]);
    expect(slides[0]).toMatchObject({ caption: "Low tide", place: "Pemaquid Point", day: "Monday, August 11, 2025" });
    expect(slides[0].src).toMatch(new RegExp(`^/api/photos/${first}/medium\\?v=`));
    expect(slides[2].day).toBeNull();
  });

  it("gives a member's title to members only", async () => {
    await mk("named", { membersTitle: "Grandma Jo at the lighthouse", takenAt: new Date("2025-08-11T15:00:00Z") });
    expect((await tripSlides(tripId, true))[0].title).toBe("Grandma Jo at the lighthouse");
    expect((await tripSlides(tripId, false))[0].title).toBeNull();
  });

  it("follows a collection's saved order when somebody has arranged it", async () => {
    const early = await mk("early", { takenAt: new Date("2025-08-11T15:00:00Z") });
    const late = await mk("late", { takenAt: new Date("2025-08-12T15:00:00Z") });
    const c = await db.collection.create({ data: { slug: "best", title: "Best", createdById: userId } });
    await db.collectionItem.create({ data: { collectionId: c.id, photoId: late, addedById: userId, position: 0 } });
    await db.collectionItem.create({ data: { collectionId: c.id, photoId: early, addedById: userId, position: 1 } });
    expect((await collectionSlides({ id: c.id, arrangedAt: null }, true)).map((s) => s.id)).toEqual([early, late]);
    expect((await collectionSlides({ id: c.id, arrangedAt: new Date() }, true)).map((s) => s.id)).toEqual([late, early]);
  });
});
