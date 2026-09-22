import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { duplicateGroups, foldDuplicates } from "@/lib/photos/duplicates";
import { resetTestDb } from "../helpers/reset";

/**
 * Folding what is already in the album. The same bytes twice is one photograph: whichever copy carries the caption,
 * the date, the place, the trip, the collection or somebody's favourite, all of it ends up on the one that is kept,
 * and the copies go to the trash rather than being destroyed.
 */
describe("folding the identical copies already in the album", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("keeps the oldest, gathers everything its copies knew, and trashes them as duplicates", async () => {
    const user = await db.user.create({ data: { email: "fold@example.com", role: "ADMIN" } });
    const other = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const trip = await db.trip.create({ data: { slug: "f", title: "F", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const collection = await db.collection.create({ data: { slug: "fav", title: "Favorites", themeKey: "default", createdById: user.id } });
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", contentHash: "same-bytes", ...extra } });

    // The one that has been here longest knows the least about itself.
    const keeper = await mk("first.jpg", { createdAt: new Date("2024-01-01"), takenAt: new Date("2025-06-01"), takenAtSource: "FILE_MTIME" });
    // A copy somebody captioned and filed on a trip.
    const withWords = await mk("second.jpg", { createdAt: new Date("2025-01-01"), caption: "Biscuit in the kayak", tripId: trip.id });
    // And one with the date off the camera and a place set by hand, gathered into a collection and favourited.
    const withFacts = await mk("third.jpg", { createdAt: new Date("2026-01-01"), takenAt: new Date("2019-08-12T10:00:00Z"), takenAtSource: "EXIF_OFFSET", lat: 44.2223, lng: -68.3372, gpsSource: "MANUAL", placeName: "Bass Harbor Head Light" });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: withFacts.id, position: 0, addedById: user.id } });
    await db.photoFavorite.create({ data: { photoId: withFacts.id, userId: other.id } });
    // Something else entirely, which must be left alone.
    const unrelated = await mk("other.jpg", { contentHash: "different-bytes" });

    expect((await duplicateGroups()).map((g) => g.ids.length)).toEqual([3]);

    const report = await foldDuplicates(user.id);
    expect(report).toMatchObject({ groups: 1, folded: 2 });

    const kept = await db.photo.findUniqueOrThrow({ where: { id: keeper.id }, include: { collections: true, favourites: true } });
    expect(kept.caption).toBe("Biscuit in the kayak");
    expect(kept.takenAtSource).toBe("EXIF_OFFSET");
    expect(kept.takenAt?.toISOString()).toBe("2019-08-12T10:00:00.000Z");
    expect(kept.placeName).toBe("Bass Harbor Head Light");
    expect(kept.gpsSource).toBe("MANUAL");
    expect(kept.tripId).toBe(trip.id);
    expect(kept.collections.map((c) => c.collectionId)).toEqual([collection.id]);
    expect(kept.favourites.map((f) => f.userId)).toEqual([other.id]);
    expect(kept.trashedAt).toBeNull();

    // The copies are in the trash, said to be duplicates and pointing at what was kept — not destroyed.
    for (const id of [withWords.id, withFacts.id]) {
      const copy = await db.photo.findUniqueOrThrow({ where: { id } });
      expect(copy.trashedAt).not.toBeNull();
      expect(copy.trashReason).toBe("DUPLICATE");
      expect(copy.trashNote).toContain(keeper.id);
    }
    expect((await db.photo.findUniqueOrThrow({ where: { id: unrelated.id } })).trashedAt).toBeNull();

    // Nothing is left to fold, and running it again changes nothing.
    expect(await duplicateGroups()).toEqual([]);
    expect(await foldDuplicates(user.id)).toMatchObject({ groups: 0, folded: 0 });
  });

  it("leaves alone what has no hash yet and what is already in the trash", async () => {
    const user = await db.user.create({ data: { email: "fold2@example.com", role: "ADMIN" } });
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...extra } });
    // Still being processed: no hash, so nothing is guessed at.
    await mk("pending-a.jpg", { status: "PENDING" });
    await mk("pending-b.jpg", { status: "PENDING" });
    // A copy already in the trash does not make a pair with the one still in the album.
    await mk("kept.jpg", { contentHash: "h" });
    await mk("gone.jpg", { contentHash: "h", trashedAt: new Date(), trashedById: user.id, trashReason: "DUPLICATE" });
    expect(await duplicateGroups()).toEqual([]);
    expect(await foldDuplicates(user.id)).toMatchObject({ groups: 0, folded: 0 });
  });
});
