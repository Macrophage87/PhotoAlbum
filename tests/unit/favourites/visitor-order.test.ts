import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Viewer } from "@/lib/auth/viewer";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }) }));

import { GET as tripPhotos } from "@/app/api/trips/[slug]/photos/route";
import { db } from "@/lib/db";
import { tripPhotoPage } from "@/lib/photos/page";
import { listVisibleTrips } from "@/lib/trips/queries";
import { listCollectionItems, listVisibleCollections } from "@/lib/collections/queries";
import { photoSortChoice, SORT_COOKIES, tripSortChoice } from "@/lib/sort-choice";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

/**
 * A visitor sees no hearts, and must not be able to read them off the order either: favourites first is a member's
 * order, and anybody else — a visitor, or a member looking through a shared link — is shown the dates.
 */
describe("the family's favourites are not an order a visitor can read", () => {
  let member: Viewer, tripId: string, collectionId: string, early: string, late: string;
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  beforeEach(async () => {
    await resetTestDb();
    jar.clear();
    const user = await db.user.create({ data: { email: "f@example.com", name: "Fay", role: "ADMIN" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "ADMIN" }, shareTokens: new Map() };
    const dates = { startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PUBLIC" as const };
    tripId = (await db.trip.create({ data: { slug: "pub", title: "Public", ...dates } })).id;
    const photo = (name: string, day: number) =>
      db.photo.create({ data: { tripId, uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", takenAt: new Date(Date.UTC(2025, 7, day)) } });
    early = (await photo("early.jpg", 11)).id;
    late = (await photo("late.jpg", 12)).id;
    // The later one is the family's favourite, so favourites first would put it ahead of the earlier one.
    await db.photoFavorite.create({ data: { userId: user.id, photoId: late } });
    collectionId = (await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "PUBLIC" } })).id;
    await db.collectionItem.createMany({ data: [late, early].map((photoId, position) => ({ collectionId, photoId, addedById: user.id, position })) });
  });

  it("orders a trip's photographs by date for anybody the query is not told is a member", async () => {
    expect(ids((await tripPhotoPage(tripId, { viewerId: member.user!.id })).photos)).toEqual([late, early]);
    expect(ids((await tripPhotoPage(tripId, { order: "favorites" })).photos)).toEqual([early, late]);
    expect(ids((await tripPhotoPage(tripId, { readyOnly: true })).photos)).toEqual([early, late]);
  });

  it("answers a visitor's later pages, and a member's through a shared link, by date whatever is asked", async () => {
    const ask = async (query: string) => ids((await (await tripPhotos(new NextRequest(`http://album.test/api/trips/pub/photos?${query}`), { params: Promise.resolve({ slug: "pub" }) } as never)).json()).photos);
    who.viewer = anon;
    expect(await ask("")).toEqual([early, late]);
    expect(await ask("order=favorites")).toEqual([early, late]);
    expect(await ask("order=newest")).toEqual([late, early]);
    who.viewer = member;
    expect(await ask("view=share&order=favorites")).toEqual([early, late]);
    expect(await ask("order=favorites")).toEqual([late, early]);
  });

  it("offers a visitor only the dates, whatever the address or the device remembers", async () => {
    jar.set(SORT_COOKIES.photos, "favorites");
    jar.set(SORT_COOKIES.trips, "favorites");
    expect(await photoSortChoice({}, false)).toBe("oldest");
    expect(await photoSortChoice({ order: "favorites" }, false)).toBe("oldest");
    expect(await photoSortChoice({}, true)).toBe("favorites");
    expect(await tripSortChoice({ order: "favorites" }, false)).toBe("newest");
    expect(await tripSortChoice({}, true)).toBe("favorites");
  });

  it("lists trips and collections for a visitor without the family's hearts", async () => {
    const older = await db.trip.create({ data: { slug: "older", title: "Older", startDate: new Date("2024-08-10"), endDate: new Date("2024-08-16"), createdById: member.user!.id, visibility: "PUBLIC" } });
    await db.tripFavorite.create({ data: { userId: member.user!.id, tripId: older.id } });
    expect(ids(await listVisibleTrips(member, { order: "favorites" }))).toEqual([older.id, tripId]);
    expect(ids(await listVisibleTrips(anon, { order: "favorites" }))).toEqual([tripId, older.id]);
    const other = await db.collection.create({ data: { slug: "d", title: "D", createdById: member.user!.id, visibility: "PUBLIC", updatedAt: new Date("2020-01-01") } });
    await db.collectionFavorite.create({ data: { userId: member.user!.id, collectionId: other.id } });
    expect(ids(await listVisibleCollections(member))).toEqual([other.id, collectionId]);
    expect(ids(await listVisibleCollections(anon))).toEqual([collectionId, other.id]);
  });

  it("shows a collection nobody arranged to a visitor by date", async () => {
    expect(ids(await listCollectionItems(collectionId, { order: "favorites", viewerId: member.user!.id }))).toEqual([late, early]);
    expect(ids(await listCollectionItems(collectionId, { order: "favorites" }))).toEqual([early, late]);
  });
});
