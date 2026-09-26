import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }) }));

import { reorderCollection, sortCollectionByDate } from "@/app/collections/actions";
import { defaultCollectionOrder, listCollectionItems } from "@/lib/collections/queries";
import { collectionSortChoice, SORT_COOKIES } from "@/lib/sort-choice";

/**
 * A collection somebody has put in order is shown in that order: saving an arrangement is not undone by the
 * favourites the family has marked, nor by whichever order this device last chose on some other grid.
 */
describe("a collection's saved order", () => {
  let collectionId: string, a: string, b: string, c: string;

  beforeEach(async () => {
    await resetTestDb();
    jar.clear();
    who.id = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    collectionId = (await db.collection.create({ data: { slug: "best", title: "Best of", createdById: who.id } })).id;
    const photo = (name: string, day: number) =>
      db.photo.create({ data: { uploaderId: who.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", takenAt: new Date(Date.UTC(2025, 7, day)) } });
    a = (await photo("a.jpg", 1)).id;
    b = (await photo("b.jpg", 2)).id;
    c = (await photo("c.jpg", 3)).id;
    await db.collectionItem.createMany({ data: [a, b, c].map((photoId, position) => ({ collectionId, photoId, addedById: who.id, position })) });
    // The family's favourite is the last one added.
    await db.photoFavorite.create({ data: { userId: who.id, photoId: c } });
  });

  const itemIds = async (order: string[]) => {
    const items = await db.collectionItem.findMany({ where: { collectionId }, select: { id: true, photoId: true } });
    return order.map((p) => items.find((i) => i.photoId === p)!.id);
  };
  const arrangedAt = async () => (await db.collection.findUniqueOrThrow({ where: { id: collectionId } })).arrangedAt;

  it("is kept, noted, and shown as saved rather than favourites first", async () => {
    expect(defaultCollectionOrder({ arrangedAt: await arrangedAt() })).toBe("favorites");
    await reorderCollection("best", await itemIds([b, a, c]));
    expect(await arrangedAt()).not.toBeNull();
    expect(defaultCollectionOrder({ arrangedAt: await arrangedAt() })).toBe("arranged");
    expect((await listCollectionItems(collectionId, { order: "arranged", viewerId: who.id })).map((i) => i.id)).toEqual([b, a, c]);
    // Shown another way, each item still knows its place in the saved order, which is what Arrange starts from.
    const byFavourite = await listCollectionItems(collectionId, { order: "favorites", viewerId: who.id });
    expect(byFavourite.map((i) => i.id)).toEqual([c, b, a]);
    expect(byFavourite.map((i) => i.arranged)).toEqual([2, 0, 1]);
  });

  it("counts sorting by date as an arrangement", async () => {
    await reorderCollection("best", await itemIds([c, b, a]));
    await db.collection.update({ where: { id: collectionId }, data: { arrangedAt: null } });
    await sortCollectionByDate("best");
    expect(await arrangedAt()).not.toBeNull();
    expect((await listCollectionItems(collectionId, { order: "arranged" })).map((i) => i.id)).toEqual([a, b, c]);
  });

  it("opens an arranged collection in its saved order whatever the device last chose, unless the address asks", async () => {
    jar.set(SORT_COOKIES.photos, "newest");
    expect(await collectionSortChoice({}, true)).toBe("arranged");
    expect(await collectionSortChoice({ order: "favorites" }, true)).toBe("favorites");
    // Nobody has arranged it: the device's habit, as on any other grid, and no saved order to ask for.
    expect(await collectionSortChoice({}, false)).toBe("newest");
    jar.clear();
    expect(await collectionSortChoice({ order: "arranged" }, false)).toBe("favorites");
  });

  it("knows each item's place in the saved order where positions have gaps and ties", async () => {
    const items = await db.collectionItem.findMany({ where: { collectionId }, select: { id: true, photoId: true } });
    const at = (p: string) => items.find((i) => i.photoId === p)!.id;
    // Gaps from items taken out, and a tie from a fold putting the kept photograph at its copy's place.
    await db.collectionItem.update({ where: { id: at(a) }, data: { position: 7, createdAt: new Date("2025-01-02") } });
    await db.collectionItem.update({ where: { id: at(b) }, data: { position: 3 } });
    await db.collectionItem.update({ where: { id: at(c) }, data: { position: 7, createdAt: new Date("2025-01-01") } });
    const arranged = await listCollectionItems(collectionId, { order: "arranged" });
    expect(arranged.map((i) => i.id)).toEqual([b, c, a]);
    expect(arranged.map((i) => i.arranged)).toEqual([0, 1, 2]);
    const newest = await listCollectionItems(collectionId, { order: "newest" });
    expect(newest.map((i) => [i.id, i.arranged])).toEqual([[c, 1], [b, 0], [a, 2]]);
  });

  describe("recognising collections arranged before the date was kept", () => {
    const backfill = () => {
      const migration = readFileSync("prisma/migrations/20260926100100_collection_arranged_at/migration.sql", "utf8");
      return db.$executeRawUnsafe(migration.slice(migration.indexOf("UPDATE")));
    };
    const collection = async (slug: string) => (await db.collection.create({ data: { slug, title: slug, createdById: who.id } })).id;
    const arrangedOf = async (id: string) => (await db.collection.findUniqueOrThrow({ where: { id } })).arrangedAt;
    const move = async (id: string, order: string[]) => {
      const items = await db.collectionItem.findMany({ where: { collectionId: id }, select: { id: true, photoId: true } });
      for (const [position, p] of order.entries()) await db.collectionItem.update({ where: { id: items.find((i) => i.photoId === p)!.id }, data: { position } });
    };

    it("leaves alone a collection added to in one go, or one by one, and never rearranged", async () => {
      // The beforeEach collection was added to in one go, at a single moment.
      const oneByOne = await collection("one-by-one");
      for (const [position, photoId] of [a, b, c].entries()) await db.collectionItem.create({ data: { collectionId: oneByOne, photoId, addedById: who.id, position } });
      await backfill();
      expect(await arrangedOf(collectionId)).toBeNull();
      expect(await arrangedOf(oneByOne)).toBeNull();
    });

    it("counts one added to in one go and then rearranged", async () => {
      await move(collectionId, [c, a, b]);
      await backfill();
      expect(await arrangedOf(collectionId)).not.toBeNull();
    });

    it("counts one added to one by one and then rearranged", async () => {
      const oneByOne = await collection("one-by-one");
      for (const [position, photoId] of [a, b, c].entries()) await db.collectionItem.create({ data: { collectionId: oneByOne, photoId, addedById: who.id, position } });
      await move(oneByOne, [b, a, c]);
      await backfill();
      expect(await arrangedOf(oneByOne)).not.toBeNull();
      expect(await arrangedOf(collectionId)).toBeNull();
    });
  });
});
