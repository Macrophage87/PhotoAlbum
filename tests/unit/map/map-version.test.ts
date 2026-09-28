import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** How far the map's version and its access part have moved since `from`. */
async function moved(from: { version: bigint; access: bigint }) {
  const [now] = await db.$queryRaw<{ version: bigint; access: bigint }[]>`SELECT "version", "access" FROM "MapVersion" WHERE "id" = 1`;
  return { version: Number(now.version - from.version), access: Number(now.access - from.access) };
}
const read = async () => (await db.$queryRaw<{ version: bigint; access: bigint }[]>`SELECT "version", "access" FROM "MapVersion" WHERE "id" = 1`)[0];

/**
 * The map's version is what decides whether a map worked out earlier still holds, so it has to move for every change
 * a map shows, move further for any change that takes something off a map, and stay put for everything else — a face
 * found or a caption written must not make every map be worked out again.
 */
describe("the map's version", () => {
  let photoId: string, tripId: string, collectionId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId, visibility: "PUBLIC" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: userId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", originalName: "a.jpg", lat: 1, lng: 1 } })).id;
    collectionId = (await db.collection.create({ data: { slug: "c", title: "C", createdById: userId, visibility: "PUBLIC" } })).id;
    await db.collectionItem.create({ data: { collectionId, photoId, addedById: userId } });
  });

  it("stays put for what no map shows, and for a place set to where it already was", async () => {
    const from = await read();
    await db.photo.update({ where: { id: photoId }, data: { caption: "On the porch", context: "Grandma's", reviewedAt: new Date() } });
    await db.photo.update({ where: { id: photoId }, data: { lat: 1, lng: 1 } });
    await db.trip.update({ where: { id: tripId }, data: { description: "A week away" } });
    await db.collection.update({ where: { id: collectionId }, data: { title: "Renamed" } });
    expect(await moved(from)).toEqual({ version: 0, access: 0 });
  });

  it("moves for a first place, a new date, a member's name, a trip's clock, and a new photograph", async () => {
    const unplaced = (await db.photo.create({ data: { uploaderId: userId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", originalName: "u.jpg" } })).id;
    for (const change of [
      () => db.photo.update({ where: { id: unplaced }, data: { lat: 2, lng: 2 } }),
      () => db.photo.update({ where: { id: photoId }, data: { takenAt: new Date() } }),
      () => db.trip.update({ where: { id: tripId }, data: { timezone: "Europe/Rome" } }),
      () => db.user.update({ where: { id: userId }, data: { name: "Jo" } }),
      () => db.photo.create({ data: { uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", originalName: "b.jpg", lat: 3, lng: 3 } }),
    ]) {
      const from = await read();
      await change();
      expect(await moved(from)).toEqual({ version: 1, access: 0 });
    }
    // Restored from the trash: back on the map, which is something more to see.
    await db.photo.update({ where: { id: photoId }, data: { trashedAt: new Date(), trashedById: userId, trashReason: "BLURRY" } });
    const trashed = await read();
    await db.photo.update({ where: { id: photoId }, data: { trashedAt: null, trashedById: null, trashReason: null } });
    expect(await moved(trashed)).toEqual({ version: 1, access: 0 });
  });

  it("files an import's photographs on a trip as something more to see, and ignores what was never on a map", async () => {
    // Processing and imports file photographs on a trip after the fact: nothing anybody saw is altered.
    await db.photo.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, originalName: `f${i}.jpg`, lat: 1, lng: 1 })) });
    const from = await read();
    await db.photo.updateMany({ where: { tripId: null }, data: { tripId } });
    expect(await moved(from)).toEqual({ version: 1, access: 0 });
    // A duplicate deleted while still being processed, a row an import gave up on, the trash emptied: no map changes.
    const pending = (await db.photo.create({ data: { uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "pending", sizeBytes: 1, status: "PENDING", originalName: "dup.jpg" } })).id;
    const failed = (await db.photo.create({ data: { uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "FAILED", originalName: "bad.jpg", lat: 1, lng: 1 } })).id;
    const binned = (await db.photo.create({ data: { uploaderId: userId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", originalName: "bin.jpg", lat: 1, lng: 1, trashedAt: new Date() } })).id;
    const quiet = await read();
    await db.photo.update({ where: { id: pending }, data: { status: "PROCESSING", takenAt: new Date(), tripId } });
    await db.photo.deleteMany({ where: { id: { in: [pending, failed, binned] } } });
    expect(await moved(quiet)).toEqual({ version: 0, access: 0 });
  });

  it("moves for writes that go round the album's own code: raw SQL, and a member's photographs handed on as they leave", async () => {
    const other = (await db.user.create({ data: { email: "o@example.com", name: "Other", role: "ADMIN" } })).id;
    for (const change of [
      // No updatedAt is touched here: what counts is the column.
      () => db.$executeRaw`UPDATE "Photo" SET "takenAt" = now() WHERE id = ${photoId}`,
      // What removing a member does (src/app/admin/actions.ts): their uploads become the admin's, in raw SQL.
      () => db.$executeRaw`UPDATE "Photo" SET "uploaderId" = CASE WHEN "uploaderId" = ${userId} THEN ${other} ELSE "uploaderId" END WHERE "uploaderId" = ${userId}`,
      () => db.$executeRaw`UPDATE "User" SET name = 'Renamed' WHERE id = ${other}`,
    ]) {
      const from = await read();
      await change();
      expect(await moved(from)).toEqual({ version: 1, access: 0 });
    }
    // And the member themself leaving, once what they made is handed on: the legend no longer has them to name.
    await db.trip.updateMany({ where: { createdById: userId }, data: { createdById: other } });
    await db.collection.updateMany({ where: { createdById: userId }, data: { createdById: other } });
    await db.collectionItem.updateMany({ where: { addedById: userId }, data: { addedById: other } });
    const from = await read();
    await db.user.delete({ where: { id: userId } });
    expect(await moved(from)).toEqual({ version: 1, access: 0 });
    // A place moved in raw SQL is caught like any other.
    const raw = await read();
    await db.$executeRaw`UPDATE "Photo" SET lat = 5 WHERE id = ${photoId}`;
    expect(await moved(raw)).toEqual({ version: 1, access: 1 });
  });

  it("moves its access part for whatever can take something off a map, move or clear a place, or rename what a map names", async () => {
    const activityId = (await db.activity.create({ data: { tripId, title: "Swim", startTime: new Date(), endTime: new Date() } })).id;
    const track = () => db.track.create({ data: { tripId, uploaderId: userId, source: "GPX", name: "Home to the beach.gpx", startTime: new Date(), endTime: new Date(), pointCount: 2, minLat: 1, maxLat: 2, minLng: 1, maxLng: 2, simplified: [], pointsBlob: new Uint8Array() } });
    const renamed = (await track()).id;
    const deleted = (await track()).id;
    const elsewhere = (await db.trip.create({ data: { slug: "e", title: "E", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId, visibility: "PUBLIC" } })).id;
    // A photograph on the map for each change to one, made before counting starts.
    const placed = async () => (await db.photo.create({ data: { uploaderId: userId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", originalName: "p.jpg", lat: 1, lng: 1 } })).id;
    const [moveIt, clearIt, trashIt, refileIt, unfileIt, failIt, deleteIt] = [await placed(), await placed(), await placed(), await placed(), await placed(), await placed(), await placed()];
    for (const change of [
      () => db.photo.update({ where: { id: moveIt }, data: { lat: 2 } }),
      () => db.photo.update({ where: { id: clearIt }, data: { lat: null, lng: null } }),
      () => db.photo.update({ where: { id: trashIt }, data: { trashedAt: new Date(), trashedById: userId, trashReason: "BLURRY" } }),
      () => db.photo.update({ where: { id: refileIt }, data: { tripId: elsewhere } }),
      () => db.photo.update({ where: { id: unfileIt }, data: { tripId: null } }),
      () => db.photo.update({ where: { id: failIt }, data: { status: "FAILED" } }),
      () => db.photo.delete({ where: { id: deleteIt } }),
      () => db.trip.update({ where: { id: tripId }, data: { title: "Renamed" } }),
      () => db.activity.update({ where: { id: activityId }, data: { title: "Renamed" } }),
      () => db.track.update({ where: { id: renamed }, data: { name: "Renamed" } }),
      () => db.track.delete({ where: { id: deleted } }),
      () => db.activity.delete({ where: { id: activityId } }),
      () => db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } }),
      () => db.trip.update({ where: { id: tripId }, data: { shareToken: "tok" } }),
      () => db.collection.update({ where: { id: collectionId }, data: { visibility: "LINK" } }),
      () => db.collectionItem.deleteMany({ where: { collectionId } }),
      () => db.$executeRawUnsafe('TRUNCATE "CollectionItem"'),
    ]) {
      const from = await read();
      await change();
      expect(await moved(from)).toEqual({ version: 1, access: 1 });
    }
  });

  it("moves once for a whole transaction, however many rows it changes", async () => {
    await db.photo.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ uploaderId: userId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, originalName: `${i}.jpg`, lat: 1, lng: 1 })) });
    const from = await read();
    await db.$transaction([db.photo.updateMany({ where: { tripId }, data: { takenAt: new Date() } }), db.trip.update({ where: { id: tripId }, data: { timezone: "Asia/Tokyo" } })]);
    expect(await moved(from)).toEqual({ version: 1, access: 0 });
    // A change of both kinds in one transaction moves both parts once.
    const again = await read();
    await db.$transaction([db.photo.updateMany({ where: { tripId }, data: { takenAt: new Date(0) } }), db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } })]);
    expect(await moved(again)).toEqual({ version: 1, access: 1 });
  });

  it("does not move for a change that is rolled back", async () => {
    const from = await read();
    await expect(
      db.$transaction(async (tx) => {
        await tx.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } });
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(await moved(from)).toEqual({ version: 0, access: 0 });
  });
});
