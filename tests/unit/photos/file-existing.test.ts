import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { db } from "@/lib/db";
import { fileExisting } from "@/lib/photos/file-existing";
import { resetTestDb } from "../helpers/reset";

/** A file the album already has, sent again to a particular trip, activity or collection, against a real database. */
describe("filing a photograph the album already has where it was sent", () => {
  let owner: { id: string; role: "ADMIN" | "MEMBER" };
  let other: { id: string; role: "ADMIN" | "MEMBER" };
  let acadia: string;
  let skye: string;
  let walk: string;
  let christmas: string;

  const photo = (tripId: string | null, activityId: string | null = null, uploaderId = owner.id) =>
    db.photo.create({ data: { uploaderId, tripId, activityId, status: "READY", originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1 }, select: { id: true } });
  const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id }, select: { tripId: true, activityId: true, collections: { select: { collectionId: true } } } });

  beforeEach(async () => {
    await resetTestDb();
    owner = await db.user.create({ data: { email: "owner@example.com", role: "MEMBER" }, select: { id: true, role: true } });
    other = await db.user.create({ data: { email: "other@example.com", role: "MEMBER" }, select: { id: true, role: true } });
    const day = new Date("2025-08-10");
    acadia = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: day, endDate: day, createdById: owner.id }, select: { id: true } })).id;
    skye = (await db.trip.create({ data: { slug: "skye", title: "Skye", startDate: day, endDate: day, createdById: owner.id }, select: { id: true } })).id;
    walk = (await db.activity.create({ data: { tripId: skye, title: "Old Man of Storr", startTime: day, endTime: day }, select: { id: true } })).id;
    christmas = (await db.collection.create({ data: { slug: "christmas", title: "Christmas mornings", createdById: owner.id }, select: { id: true } })).id;
  });

  it("puts one with no trip on the trip it was sent to, without making another", async () => {
    const p = await photo(null);
    const filed = await fileExisting(owner, p.id, { tripId: acadia });
    expect(filed).toMatchObject({ trip: true, movedFrom: null, notYours: false });
    expect((await row(p.id)).tripId).toBe(acadia);
    expect(await db.photo.count()).toBe(1);
  });

  it("moves one on another trip, says where from, and drops the old trip's activity", async () => {
    const onAcadia = await db.activity.create({ data: { tripId: acadia, title: "Ocean Path", startTime: new Date(), endTime: new Date() }, select: { id: true } });
    const p = await photo(acadia, onAcadia.id);
    const filed = await fileExisting(owner, p.id, { tripId: skye });
    expect(filed.movedFrom).toBe("Acadia");
    expect(await row(p.id)).toMatchObject({ tripId: skye, activityId: null });
  });

  it("attaches it to the activity it was sent to, and so to that activity's trip", async () => {
    const p = await photo(acadia);
    const filed = await fileExisting(owner, p.id, { tripId: skye, activityId: walk });
    expect(filed).toMatchObject({ trip: true, activity: true, movedFrom: "Acadia" });
    expect(await row(p.id)).toMatchObject({ tripId: skye, activityId: walk });
  });

  it("adds it to the collection as well as wherever else it is, once", async () => {
    const p = await photo(acadia);
    await fileExisting(owner, p.id, { collectionId: christmas });
    await fileExisting(owner, p.id, { collectionId: christmas });
    const r = await row(p.id);
    expect(r.collections.map((c) => c.collectionId)).toEqual([christmas]);
    // A collection is a label, not a place: it stays on its trip.
    expect(r.tripId).toBe(acadia);
  });

  it("leaves somebody else's where it is and says so", async () => {
    const p = await photo(acadia, null, other.id);
    const filed = await fileExisting(owner, p.id, { tripId: skye, collectionId: christmas });
    expect(filed).toMatchObject({ trip: false, collection: false, notYours: true });
    const r = await row(p.id);
    expect(r.tripId).toBe(acadia);
    expect(r.collections).toEqual([]);
  });

  it("lets an admin file anybody's", async () => {
    const admin = await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" }, select: { id: true, role: true } });
    const p = await photo(null, null, other.id);
    expect((await fileExisting(admin, p.id, { tripId: acadia })).trip).toBe(true);
    expect((await row(p.id)).tripId).toBe(acadia);
  });

  it("does nothing when nowhere in particular was asked for", async () => {
    const p = await photo(acadia);
    expect(await fileExisting(owner, p.id, {})).toMatchObject({ trip: false, activity: false, collection: false });
    expect((await row(p.id)).tripId).toBe(acadia);
  });
});
