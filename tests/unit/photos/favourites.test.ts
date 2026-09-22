import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { favouritesFor, setFavourite } from "@/lib/favourites/queries";
import { listVisibleTrips } from "@/lib/trips/queries";
import { listVisibleCollections } from "@/lib/collections/queries";
import { listCollectionItems } from "@/lib/collections/queries";
import { tripPhotoPage } from "@/lib/photos/page";
import { tileDate } from "@/components/photos/PhotoGrid";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const viewerFor = (id: string, email: string): Viewer => ({ kind: "user", user: { id, email, name: null, role: "MEMBER" }, shareTokens: new Map() });
const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

describe("favorites", () => {
  let me: string, you: string, tripA: string, tripB: string, colA: string, colB: string;
  let p1: string, p2: string, p3: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    you = (await db.user.create({ data: { email: "you@example.com" } })).id;
    const trip = (t: string, day: string) => db.trip.create({ data: { slug: t, title: t, startDate: new Date(day), endDate: new Date(day), createdById: me, visibility: "PUBLIC" } });
    tripA = (await trip("older", "2025-08-01")).id;
    tripB = (await trip("newer", "2025-08-20")).id;
    colA = (await db.collection.create({ data: { slug: "a", title: "A", createdById: me, visibility: "PUBLIC" } })).id;
    colB = (await db.collection.create({ data: { slug: "b", title: "B", createdById: me, visibility: "PUBLIC" } })).id;
    const photo = (name: string, minute: number) =>
      db.photo.create({ data: { tripId: tripA, uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(Date.UTC(2025, 7, 1, 12, minute)), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0 } });
    p1 = (await photo("1.jpg", 1)).id;
    p2 = (await photo("2.jpg", 2)).id;
    p3 = (await photo("3.jpg", 3)).id;
  });

  it("counts mine and the family's separately, and marking twice is still once", async () => {
    expect(await setFavourite("photo", p2, me, true)).toEqual({ mine: true, count: 1 });
    expect(await setFavourite("photo", p2, me, true)).toEqual({ mine: true, count: 1 });
    expect(await setFavourite("photo", p2, you, true)).toEqual({ mine: true, count: 2 });
    const state = await favouritesFor("photo", [p1, p2], viewerFor(me, "me@example.com"));
    expect(state.get(p2)).toEqual({ mine: true, count: 2 });
    expect(state.get(p1)).toEqual({ mine: false, count: 0 });
    // Somebody else's mark is a count, not a claim on my heart.
    expect((await favouritesFor("photo", [p2], viewerFor(you, "you@example.com"))).get(p2)).toEqual({ mine: true, count: 2 });
    expect(await setFavourite("photo", p2, you, false)).toEqual({ mine: false, count: 1 });
  });

  it("puts my photos first, then the ones most of us marked, then the order the day happened in", async () => {
    await setFavourite("photo", p3, you, true); // one mark from somebody else
    await setFavourite("photo", p2, you, true);
    await setFavourite("photo", p2, me, true); // mine, and two in all
    const page = await tripPhotoPage(tripA, { viewerId: me });
    expect(page.photos.map((p) => p.id)).toEqual([p2, p3, p1]);
    // Someone who has marked nothing sees the family's order, then chronology.
    expect((await tripPhotoPage(tripA, { viewerId: you })).photos.map((p) => p.id)).toEqual([p2, p3, p1]);
    // And the plain chronological order is still available.
    expect((await tripPhotoPage(tripA, { viewerId: me, order: "taken" })).photos.map((p) => p.id)).toEqual([p1, p2, p3]);
  });

  it("orders trips and collections the same way, for the person looking", async () => {
    await setFavourite("trip", tripA, me, true);
    expect((await listVisibleTrips(viewerFor(me, "me@example.com"))).map((t) => t.id)).toEqual([tripA, tripB]);
    // Without that mark the newest leads again.
    expect((await listVisibleTrips(viewerFor(you, "you@example.com"))).map((t) => t.id)).toEqual([tripA, tripB]);
    expect((await listVisibleTrips(anon)).map((t) => t.id)).toEqual([tripA, tripB]);

    await setFavourite("collection", colA, you, true);
    await setFavourite("collection", colA, me, true);
    expect((await listVisibleCollections(viewerFor(me, "me@example.com"))).map((c) => c.id)).toEqual([colA, colB]);
  });

  it("leads a collection with favorites, keeping the arranged order underneath", async () => {
    for (const [i, id] of [p1, p2, p3].entries()) await db.collectionItem.create({ data: { collectionId: colB, photoId: id, addedById: me, position: i } });
    await setFavourite("photo", p3, me, true);
    expect((await listCollectionItems(colB, { viewerId: me })).map((p) => p.id)).toEqual([p3, p1, p2]);
    expect((await listCollectionItems(colB, { viewerId: me, order: "arranged" })).map((p) => p.id)).toEqual([p1, p2, p3]);
  });

  it("shows a tile's date in the photo's own zone", () => {
    expect(tileDate("2025-08-12T02:30:00.000Z", -300)).toBe("Aug 11, 2025");
    expect(tileDate(null, 0)).toBeNull();
  });
});
