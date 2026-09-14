import { NO_PICKER_FILTER } from "@/lib/photos/picker-filter";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { tripPhotoPage } from "@/lib/photos/page";
import { tripTimeline } from "@/lib/timeline/queries";
import { resetTestDb } from "../helpers/reset";

describe("cursor pagination", () => {
  let tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "p@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "p", title: "P", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    tripId = trip.id;
    await db.photo.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ tripId, uploaderId: user.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, takenAt: new Date(Date.UTC(2025, 7, 10 + Math.floor(i / 10), 12, i)), takenAtSource: "EXIF_OFFSET" as const, tzOffsetMin: 0 })),
    });
  });

  it("walks the gallery in capture order without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await tripPhotoPage(tripId, { cursor, take: 10 });
      expect(page.total).toBe(25);
      seen.push(...page.photos.map((p) => p.originalName));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `${i}.jpg`));
  });

  it("pages the timeline at day boundaries, links the following page, and keeps undated photos for the last page", async () => {
    const user = await db.user.findFirstOrThrow();
    await db.photo.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ tripId, uploaderId: user.id, originalName: `undated-${i}.jpg`, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const })) });
    const first = await tripTimeline(tripId, "UTC", { limit: 15 });
    expect(first.groups.map((g) => g.dayKey)).toEqual(["2025-08-10"]); // the partial second day waits for the next page
    expect(first.next).not.toBeNull();
    const second = await tripTimeline(tripId, "UTC", { cursor: first.next, limit: 15 });
    expect(second.groups.map((g) => g.dayKey)).toEqual(["2025-08-11", "2025-08-12", null]);
    expect(second.groups[2].items[0].photos).toHaveLength(3);
    expect(second.next).toBeNull();
  });

  it("does not skip photos that share the cursor's second", async () => {
    const user = await db.user.findFirstOrThrow();
    const t = new Date("2025-09-01T10:00:00Z");
    await db.photo.createMany({ data: Array.from({ length: 6 }, (_, i) => ({ tripId, uploaderId: user.id, originalName: `burst-${i}.jpg`, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, takenAt: t, takenAtSource: "EXIF_OFFSET" as const, tzOffsetMin: 0 })) });
    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof tripTimeline>>["next"];
    do {
      const page = await tripTimeline(tripId, "UTC", { cursor, limit: 4 });
      for (const g of page.groups) for (const it of g.items) seen.push(...it.photos.map((p) => p.originalName));
      cursor = page.next;
    } while (cursor);
    expect(seen.filter((n) => n.startsWith("burst-"))).toHaveLength(6);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("candidate photos for a collection", () => {
  it("offers ready items not yet in the collection, newest first, filtered by trip or a word", async () => {
    const { candidatePhotoPage } = await import("@/lib/photos/page");
    await resetTestDb();
    const user = await db.user.create({ data: { email: "cand@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "c", title: "C", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const collection = await db.collection.create({ data: { slug: "best", title: "Best", themeKey: "default", createdById: user.id } });
    const mk = (name: string, extra: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...extra } });
    const inTrip = await mk("trip.jpg", { tripId: trip.id, takenAt: new Date("2025-08-12T10:00:00Z"), caption: "Lake at dawn" });
    const loose = await mk("loose.jpg", { takenAt: new Date("2025-08-13T10:00:00Z") });
    const held = await mk("held.jpg", { takenAt: new Date("2025-08-14T10:00:00Z") });
    await mk("pending.jpg", { status: "PENDING" });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: held.id, position: 0, addedById: user.id } });
    const all = await candidatePhotoPage({ kind: "collection", id: collection.id });
    expect(all.photos.map((p) => p.id)).toEqual([loose.id, inTrip.id]);
    expect(all.total).toBe(2);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, trip: trip.id })).photos.map((p) => p.id)).toEqual([inTrip.id]);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, trip: "none" })).photos.map((p) => p.id)).toEqual([loose.id]);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, q: "LAKE" })).photos.map((p) => p.id)).toEqual([inTrip.id]);
    // The AI description is searched too, through the members' index.
    await db.photo.update({ where: { id: loose.id }, data: { annotation: { caption: "x", description: "Two kayaks pulled up on the shingle", tags: ["kayak"], searchSummary: "kayaks on the beach" } } });
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, q: "kayaks" })).photos.map((p) => p.id)).toEqual([loose.id]);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, from: "2025-08-13", to: "2025-08-13" })).photos.map((p) => p.id)).toEqual([loose.id]);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, { ...NO_PICKER_FILTER, to: "2025-08-12" })).photos.map((p) => p.id)).toEqual([inTrip.id]);
    const first = await candidatePhotoPage({ kind: "collection", id: collection.id }, NO_PICKER_FILTER, { take: 1 });
    expect(first.nextCursor).toBe(loose.id);
    expect((await candidatePhotoPage({ kind: "collection", id: collection.id }, NO_PICKER_FILTER, { take: 1, cursor: first.nextCursor })).photos.map((p) => p.id)).toEqual([inTrip.id]);
  });
});

/**
 * The picker looks through everything the family has ever uploaded for the ones that belong somewhere new, so the
 * questions it can be asked are about when and where a photograph was taken and whether anything has claimed it.
 */
describe("picking photographs to put somewhere", () => {
  it("finds them by place, by distance from a point, and by nothing having claimed them", async () => {
    const { candidatePhotoPage } = await import("@/lib/photos/page");
    const { NO_PICKER_FILTER } = await import("@/lib/photos/picker-filter");
    await resetTestDb();
    const user = await db.user.create({ data: { email: "pick@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "p", title: "P", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const collection = await db.collection.create({ data: { slug: "gather", title: "Gather", themeKey: "default", createdById: user.id } });
    const mk = (name: string, extra: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...extra } });

    // Bass Harbor Head Light, and a photograph about twelve miles away at Bar Harbor.
    const lighthouse = await mk("light.jpg", { lat: 44.2223, lng: -68.3372, placeName: "Bass Harbor Head Light", takenAt: new Date("2025-08-12T10:00:00Z") });
    const barHarbor = await mk("town.jpg", { lat: 44.3876, lng: -68.2039, takenAt: new Date("2025-08-13T10:00:00Z") });
    // Far away, and claimed by a trip.
    const faraway = await mk("far.jpg", { lat: 37.8651, lng: -119.5383, tripId: trip.id, takenAt: new Date("2025-08-14T10:00:00Z") });
    // Claimed by the collection we are adding to, so it is never offered.
    const held = await mk("held.jpg", { lat: 44.22, lng: -68.34 });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: held.id, position: 0, addedById: user.id } });

    const into = { kind: "collection" as const, id: collection.id };
    const ids = async (f: Partial<typeof NO_PICKER_FILTER>) => (await candidatePhotoPage(into, { ...NO_PICKER_FILTER, ...f })).photos.map((p) => p.id).sort();

    // The place a member wrote on a photograph is searchable, which it was not before.
    expect(await ids({ q: "Bass Harbor" })).toEqual([lighthouse.id]);

    // Five miles of the lighthouse reaches the lighthouse and nothing else; thirty reaches the town as well.
    const near = (miles: number) => ({ near: { lat: 44.2223, lng: -68.3372, miles, label: null } });
    expect(await ids(near(1))).toEqual([lighthouse.id]);
    expect(await ids(near(25))).toEqual([barHarbor.id, lighthouse.id].sort());
    expect(await ids(near(500))).not.toContain(faraway.id);

    // Nothing has claimed these two: no trip, and in no collection.
    expect(await ids({ loose: true })).toEqual([barHarbor.id, lighthouse.id].sort());

    // Asked two things at once, only what answers both comes back.
    expect(await ids({ loose: true, ...near(1) })).toEqual([lighthouse.id]);
    expect(await ids({ q: "Bass Harbor", ...near(1) })).toEqual([lighthouse.id]);
    expect(await ids({ q: "Bass Harbor", near: { lat: 37.8651, lng: -119.5383, miles: 1, label: null } })).toEqual([]);

    // Putting things on a trip offers everything not already on it, including what other trips hold.
    const onto = { kind: "trip" as const, id: trip.id };
    const forTrip = (await candidatePhotoPage(onto, { ...NO_PICKER_FILTER, loose: true })).photos.map((p) => p.id).sort();
    expect(forTrip).toEqual([barHarbor.id, lighthouse.id].sort());
    expect(forTrip).not.toContain(faraway.id);
  });
});
