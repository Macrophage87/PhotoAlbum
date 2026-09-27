import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("takes a copy's date with its zone and whoever set it, and never writes over words typed on the keeper meanwhile", async () => {
    const user = await db.user.create({ data: { email: "fold@example.com", role: "ADMIN" } });
    const cousin = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", contentHash: "same-bytes", ...extra } });
    const keeper = await mk("first.jpg", { createdAt: new Date("2024-01-01"), takenAt: new Date("2025-06-01"), takenAtSource: "FILE_MTIME", tzOffsetMin: 0 });
    // Dated by hand on the copy, in Maine in summer.
    await mk("second.jpg", { createdAt: new Date("2025-01-01"), caption: "Biscuit in the kayak", title: "Kayak day", takenAt: new Date("2019-08-12T14:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: cousin.id });
    // The member captions and titles the keeper after the fold read the group.
    const real = db.photo.findMany.bind(db.photo);
    const spy = vi.spyOn(db.photo, "findMany").mockImplementationOnce((async (args: never) => {
      const read = await real(args);
      await db.photo.update({ where: { id: keeper.id }, data: { caption: "Our own words", title: "Our title", titleByHelper: false } });
      return read;
    }) as never);
    await foldDuplicates(user.id, [{ contentHash: "same-bytes", ids: (await real({ where: { contentHash: "same-bytes" }, select: { id: true } })).map((p) => p.id) }]);
    spy.mockRestore();
    const kept = await db.photo.findUniqueOrThrow({ where: { id: keeper.id } });
    expect(kept).toMatchObject({ caption: "Our own words", title: "Our title", titleByHelper: false, takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: cousin.id });
    expect(kept.takenAt?.toISOString()).toBe("2019-08-12T14:00:00.000Z");
  });

  it("skips a group whose keeper went to the trash meanwhile, copies a setter as it is now, and folds the rest when one group fails", async () => {
    const user = await db.user.create({ data: { email: "fold@example.com", role: "ADMIN" } });
    const cousin = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const mk = (name: string, hash: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", contentHash: hash, ...extra } });
    const aKeeper = await mk("a1.jpg", "a", { createdAt: new Date("2024-01-01") });
    const aCopy = await mk("a2.jpg", "a", { createdAt: new Date("2025-01-01"), caption: "From a" });
    const bKeeper = await mk("b1.jpg", "b", { createdAt: new Date("2024-01-01"), takenAt: new Date("2025-06-01"), takenAtSource: "FILE_MTIME" });
    await mk("b2.jpg", "b", { createdAt: new Date("2025-01-01"), takenAt: new Date("2019-08-12T14:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: cousin.id });
    const cKeeper = await mk("c1.jpg", "c", { createdAt: new Date("2024-01-01") });
    const cCopy = await mk("c2.jpg", "c", { createdAt: new Date("2025-01-01"), caption: "From c" });
    const dKeeper = await mk("d1.jpg", "d", { createdAt: new Date("2024-01-01") });
    await mk("d2.jpg", "d", { createdAt: new Date("2025-01-01"), caption: "From d" });
    const groups = await duplicateGroups();
    const order = ["a", "b", "c", "d"];
    groups.sort((x, y) => order.indexOf(x.contentHash) - order.indexOf(y.contentHash));

    const real = db.photo.findMany.bind(db.photo);
    const realItems = db.collectionItem.findMany.bind(db.collectionItem);
    let reads = 0;
    const spy = vi.spyOn(db.photo, "findMany").mockImplementation((async (args: never) => {
      const read = await real(args);
      reads++;
      // Group a: its keeper goes to the trash after the group was read. Group b: the member who dated the copy is
      // removed after it was read.
      if (reads === 1) await db.photo.update({ where: { id: aKeeper.id }, data: { trashedAt: new Date() } });
      if (reads === 2) await db.user.delete({ where: { id: cousin.id } });
      return read;
    }) as never);
    // Group c fails part-way (after its keeper was filled): the others are still folded.
    let items = 0;
    const itemsSpy = vi.spyOn(db.collectionItem, "findMany").mockImplementation((async (args: never) => {
      if (++items === 2) throw new Error("connection reset");
      return realItems(args);
    }) as never);
    const report = await foldDuplicates(user.id, groups);
    spy.mockRestore();
    itemsSpy.mockRestore();

    expect(report).toMatchObject({ groups: 2, failed: 1 });
    // a: nothing folded into a keeper in the trash; its copy stays.
    expect(await db.photo.findUniqueOrThrow({ where: { id: aCopy.id } })).toMatchObject({ trashedAt: null });
    expect((await db.photo.findUniqueOrThrow({ where: { id: aKeeper.id } })).caption).toBeNull();
    // b: the date came over with its zone, and no setter who is gone.
    expect(await db.photo.findUniqueOrThrow({ where: { id: bKeeper.id } })).toMatchObject({ takenAtSource: "MANUAL", tzOffsetMin: -240, dateSetById: null });
    // c failed and is tried again next time; d was folded all the same.
    expect((await db.photo.findUniqueOrThrow({ where: { id: cCopy.id } })).trashedAt).toBeNull();
    expect((await db.photo.findUniqueOrThrow({ where: { id: cKeeper.id } })).caption).toBe("From c");
    expect((await db.photo.findUniqueOrThrow({ where: { id: dKeeper.id } })).caption).toBe("From d");
  });

  it("puts the kept photograph wherever a copy of it had been chosen as the cover", async () => {
    const user = await db.user.create({ data: { email: "fold3@example.com", role: "ADMIN" } });
    const mkTrip = (slug: string) => db.trip.create({ data: { slug, title: slug, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const trip = await mkTrip("acadia");
    const elsewhere = await mkTrip("zion");
    const walk = await db.activity.create({ data: { tripId: trip.id, title: "Walk", type: "HIKE", startTime: new Date("2025-08-12T08:00:00Z"), endTime: new Date("2025-08-12T18:00:00Z") } });
    const collection = await db.collection.create({ data: { slug: "best", title: "Best of", createdById: user.id } });
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", contentHash: "cover-bytes", ...extra } });
    // The keeper is filed nowhere; the copy, on the walk, fronts the trip, the walk and a collection.
    const keeper = await mk("first.jpg", { createdAt: new Date("2024-01-01") });
    const copy = await mk("second.jpg", { createdAt: new Date("2025-01-01"), tripId: trip.id, activityId: walk.id });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: copy.id, position: 0, addedById: user.id } });
    await db.trip.update({ where: { id: trip.id }, data: { coverPhotoId: copy.id } });
    await db.activity.update({ where: { id: walk.id }, data: { coverPhotoId: copy.id } });
    await db.collection.update({ where: { id: collection.id }, data: { coverPhotoId: copy.id } });
    // A trip the keeper will not be on is not handed it: there that cover could not stand. It keeps naming the copy,
    // now in the trash and so not honoured.
    await db.trip.update({ where: { id: elsewhere.id }, data: { coverPhotoId: copy.id } });
    // Likewise an activity on the keeper's trip that the keeper is not on, and a collection it is not in.
    const swim = await db.activity.create({ data: { tripId: trip.id, title: "Swim", type: "OTHER", startTime: new Date("2025-08-13T08:00:00Z"), endTime: new Date("2025-08-13T18:00:00Z") } });
    await db.activity.update({ where: { id: swim.id }, data: { coverPhotoId: copy.id } });
    const stale = await db.collection.create({ data: { slug: "stale", title: "Stale", createdById: user.id, coverPhotoId: copy.id } });

    const report = await foldDuplicates(user.id);

    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).coverPhotoId).toBe(keeper.id);
    expect((await db.activity.findUniqueOrThrow({ where: { id: walk.id } })).coverPhotoId).toBe(keeper.id);
    expect((await db.collection.findUniqueOrThrow({ where: { id: collection.id } })).coverPhotoId).toBe(keeper.id);
    expect((await db.trip.findUniqueOrThrow({ where: { id: elsewhere.id } })).coverPhotoId).toBe(copy.id);
    expect((await db.activity.findUniqueOrThrow({ where: { id: swim.id } })).coverPhotoId).toBe(copy.id);
    expect((await db.collection.findUniqueOrThrow({ where: { id: stale.id } })).coverPhotoId).toBe(copy.id);
    // None of those was showing the copy (it was not on them), so nothing anyone saw has changed to report.
    expect(report.coversReleased).toEqual([]);
  });

  it("says which covers showing a copy could not follow it to the photograph kept", async () => {
    const user = await db.user.create({ data: { email: "fold5@example.com", role: "ADMIN" } });
    const mkTrip = (slug: string) => db.trip.create({ data: { slug, title: slug, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const acadia = await mkTrip("acadia");
    const zion = await mkTrip("zion");
    const swim = await db.activity.create({ data: { tripId: zion.id, title: "Swim", type: "OTHER", startTime: new Date("2025-08-13T08:00:00Z"), endTime: new Date("2025-08-13T18:00:00Z") } });
    const mk = (name: string, extra: Record<string, unknown>) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 1200, height: 800, contentHash: "shown-bytes", ...extra } });
    // The keeper is filed on one trip, the copy on another, where it fronts the trip and one of its outings.
    await mk("first.jpg", { createdAt: new Date("2024-01-01"), tripId: acadia.id });
    const copy = await mk("second.jpg", { createdAt: new Date("2025-01-01"), tripId: zion.id, activityId: swim.id });
    await db.trip.update({ where: { id: zion.id }, data: { coverPhotoId: copy.id } });
    await db.activity.update({ where: { id: swim.id }, data: { coverPhotoId: copy.id } });

    const report = await foldDuplicates(user.id);
    expect(report.coversReleased.sort()).toEqual(["Swim", "zion"]);
  });

  it("keeps a finished copy rather than an older one whose processing failed", async () => {
    const user = await db.user.create({ data: { email: "fold4@example.com", role: "ADMIN" } });
    const mk = (name: string, extra: Record<string, unknown>) =>
      db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, contentHash: "failed-bytes", ...extra } });
    const broken = await mk("first.jpg", { createdAt: new Date("2024-01-01"), status: "FAILED" });
    const fine = await mk("second.jpg", { createdAt: new Date("2025-01-01"), status: "READY" });
    await foldDuplicates(user.id);
    expect((await db.photo.findUniqueOrThrow({ where: { id: fine.id } })).trashedAt).toBeNull();
    expect((await db.photo.findUniqueOrThrow({ where: { id: broken.id } })).trashedAt).not.toBeNull();
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
