import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { collectionCoverCandidates, tripCoverCandidates } from "@/lib/covers/candidates";
import { coverFor } from "@/lib/trips/queries";
import { collectionCoverFor } from "@/lib/collections/queries";
import { resetTestDb } from "../helpers/reset";

describe("what a trip or collection can be fronted by", () => {
  let me: string, tripId: string, collectionId: string;
  let first: string, second: string, unfinished: string, binned: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
    collectionId = (await db.collection.create({ data: { slug: "best", title: "Best of", createdById: me } })).id;
    const photo = (name: string, hour: number, status: "READY" | "PROCESSING", trashed = false) =>
      db.photo.create({
        data: { tripId, uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status, takenAt: new Date(Date.UTC(2025, 7, 12, hour)), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0, ...(trashed ? { trashedAt: new Date(), trashedById: me, trashReason: "DUPLICATE" } : {}) },
      });
    second = (await photo("second.jpg", 15, "READY")).id;
    first = (await photo("first.jpg", 9, "READY")).id;
    unfinished = (await photo("working.jpg", 10, "PROCESSING")).id;
    binned = (await photo("gone.jpg", 11, "READY", true)).id;
  });

  it("offers the finished photographs in the order the day happened, and nothing from the trash", async () => {
    const { photos, total } = await tripCoverCandidates(tripId);
    expect(photos.map((p) => p.id)).toEqual([first, second]);
    expect(total).toBe(2);
    expect(photos.map((p) => p.id)).not.toContain(unfinished);
    expect(photos.map((p) => p.id)).not.toContain(binned);
  });

  it("pages through a long trip a screenful at a time", async () => {
    const page = await tripCoverCandidates(tripId, null, 1);
    expect(page.photos.map((p) => p.id)).toEqual([first]);
    expect(page.nextCursor).toBe(first);
    const next = await tripCoverCandidates(tripId, page.nextCursor, 1);
    expect(next.photos.map((p) => p.id)).toEqual([second]);
    expect(next.nextCursor).toBeNull();
  });

  it("offers a collection's items in the order somebody arranged them", async () => {
    await db.collectionItem.createMany({ data: [{ collectionId, photoId: second, addedById: me, position: 0 }, { collectionId, photoId: first, addedById: me, position: 1 }] });
    const { photos } = await collectionCoverCandidates(collectionId);
    expect(photos.map((p) => p.id)).toEqual([second, first]);
  });

  it("falls back to the front of the list where nobody has chosen, and to the choice where somebody has", async () => {
    const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId }, include: { coverPhoto: { select: { id: true, updatedAt: true } } } });
    expect((await coverFor(trip))?.id).toBe(first);
    await db.trip.update({ where: { id: tripId }, data: { coverPhotoId: second } });
    const chosen = await db.trip.findUniqueOrThrow({ where: { id: tripId }, include: { coverPhoto: { select: { id: true, updatedAt: true } } } });
    expect((await coverFor(chosen))?.id).toBe(second);

    await db.collectionItem.createMany({ data: [{ collectionId, photoId: second, addedById: me, position: 0 }, { collectionId, photoId: first, addedById: me, position: 1 }] });
    const collection = await db.collection.findUniqueOrThrow({ where: { id: collectionId }, include: { coverPhoto: { select: { id: true, updatedAt: true } } } });
    expect((await collectionCoverFor(collection))?.id).toBe(second);
  });
});
