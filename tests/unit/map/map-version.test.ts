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

  it("moves for a new place, a new date, a new name, and a new photograph", async () => {
    for (const change of [
      () => db.photo.update({ where: { id: photoId }, data: { lat: 2 } }),
      () => db.photo.update({ where: { id: photoId }, data: { takenAt: new Date() } }),
      () => db.trip.update({ where: { id: tripId }, data: { title: "Renamed" } }),
      () => db.user.update({ where: { id: userId }, data: { name: "Jo" } }),
      () => db.photo.create({ data: { uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "PENDING", originalName: "b.jpg" } }),
    ]) {
      const from = await read();
      await change();
      expect(await moved(from)).toEqual({ version: 1, access: 0 });
    }
  });

  it("moves for writes that go round the album's own code: raw SQL, and a member's photographs handed on as they leave", async () => {
    const other = (await db.user.create({ data: { email: "o@example.com", name: "Other", role: "ADMIN" } })).id;
    for (const change of [
      // No updatedAt is touched here: what counts is the column.
      () => db.$executeRaw`UPDATE "Photo" SET lat = 5 WHERE id = ${photoId}`,
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
  });

  it("moves its access part for whatever can take something off a map for somebody", async () => {
    for (const change of [
      () => db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } }),
      () => db.trip.update({ where: { id: tripId }, data: { shareToken: "tok" } }),
      () => db.collection.update({ where: { id: collectionId }, data: { visibility: "LINK" } }),
      () => db.collectionItem.deleteMany({ where: { collectionId } }),
      () => db.photo.update({ where: { id: photoId }, data: { trashedAt: new Date(), trashedById: userId, trashReason: "BLURRY" } }),
      () => db.photo.update({ where: { id: photoId }, data: { tripId: null } }),
      () => db.photo.delete({ where: { id: photoId } }),
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
    await db.$transaction([db.photo.updateMany({ where: { tripId }, data: { lat: 3 } }), db.trip.update({ where: { id: tripId }, data: { title: "Again" } })]);
    expect(await moved(from)).toEqual({ version: 1, access: 0 });
    // A change of both kinds in one transaction moves both parts once.
    const again = await read();
    await db.$transaction([db.photo.updateMany({ where: { tripId }, data: { lat: 4 } }), db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } })]);
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
