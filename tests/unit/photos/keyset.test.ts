import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unassignedPhotoPage } from "@/lib/photos/queries";
import { candidatePhotoPage, offsetCursor, tripPhotoPage } from "@/lib/photos/page";
import { decodeCursor, encodeCursor, type KeyColumn } from "@/lib/photos/keyset";
import { NO_FILTER } from "@/lib/photos/filters";
import { NO_PICKER_FILTER } from "@/lib/photos/picker-filter";
import { resetTestDb } from "../helpers/reset";

type Page = { photos: { id: string }[]; nextCursor: string | null };

/**
 * Walk a gallery to its end, doing `between` to the photo the cursor was taken from before each next page — the
 * thing a family member does in another tab while somebody else is scrolling.
 */
async function walk(load: (cursor: string | null) => Promise<Page>, between: (id: string) => Promise<unknown> = async () => {}) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await load(cursor);
    seen.push(...page.photos.map((p) => p.id));
    if (!page.nextCursor) return seen;
    await between(page.photos[page.photos.length - 1].id);
    cursor = page.nextCursor;
  }
  throw new Error("never ended");
}

describe("paging by position rather than by the row the cursor came from", () => {
  let userId: string, tripId: string, otherTrip: string;
  const base = () => ({ uploaderId: userId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const });
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "k@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "k", title: "K", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } })).id;
    otherTrip = (await db.trip.create({ data: { slug: "o", title: "O", startDate: new Date("2025-09-10"), endDate: new Date("2025-09-16"), createdById: userId } })).id;
    // Ties on every column, as a burst from one camera or a Takeout import arriving in one go has them, and a few
    // with no date, which sort last whichever way the grid runs.
    await db.photo.createMany({
      data: Array.from({ length: 14 }, (_, i) => ({
        ...base(),
        originalName: `${i}.jpg`,
        tripId: i < 12 ? tripId : null,
        takenAt: i % 5 === 4 ? null : new Date(Date.UTC(2025, 7, 11, 12, Math.floor(i / 3))),
        createdAt: new Date(Date.UTC(2025, 8, 1, 0, Math.floor(i / 4))),
      })),
    });
    await db.photo.createMany({ data: Array.from({ length: 9 }, (_, i) => ({ ...base(), originalName: `loose-${i}.jpg`, createdAt: new Date(Date.UTC(2025, 0, 1, 0, Math.floor(i / 3))) })) });
  });
  afterEach(() => vi.restoreAllMocks());

  const unassigned = (cursor: string | null) => unassignedPhotoPage(NO_FILTER, { cursor, take: 4 });
  const remaining = async (where: object, orderBy: object[]) => (await db.photo.findMany({ where: { trashedAt: null, ...where }, orderBy, select: { id: true } })).map((p) => p.id);
  const unassignedOrder = [{ createdAt: "desc" }, { id: "desc" }];

  it("skips nothing when the photo a page ended on is filed on a trip before the next page", async () => {
    const seen = await walk(unassigned, (id) => db.photo.update({ where: { id }, data: { tripId } }));
    const filed = await remaining({ tripId }, []);
    const left = await remaining({ tripId: null }, unassignedOrder);
    // Everything still on no trip was shown, once each, in order; the ones filed away were shown before they went.
    expect(seen.filter((id) => left.includes(id))).toEqual(left);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(left.length + seen.filter((id) => filed.includes(id)).length);
  });

  it("skips nothing when the photo a page ended on goes in the bin", async () => {
    const all = await remaining({ tripId: null }, unassignedOrder);
    const seen = await walk(unassigned, (id) => db.photo.update({ where: { id }, data: { trashedAt: new Date() } }));
    expect(seen).toEqual(all);
  });

  it("carries on past a photo deleted outright rather than ending the gallery there", async () => {
    const all = await remaining({ tripId: null }, unassignedOrder);
    const gone: string[] = [];
    const seen = await walk(unassigned, (id) => {
      gone.push(id);
      return db.photo.delete({ where: { id } });
    });
    expect(gone.length).toBeGreaterThan(1);
    expect(seen).toEqual(all);
  });

  for (const order of ["taken", "newest"] as const) {
    it(`walks a trip ${order === "taken" ? "earliest" : "latest"} first through ties and the undated, whatever leaves it meanwhile`, async () => {
      const dir = order === "taken" ? "asc" : "desc";
      const all = await remaining({ tripId }, [{ takenAt: { sort: dir, nulls: "last" } }, { createdAt: dir }, { id: dir }]);
      const seen = await walk((cursor) => tripPhotoPage(tripId, { cursor, take: 3, order }), (id) => db.photo.update({ where: { id }, data: { tripId: otherTrip } }));
      expect(seen).toEqual(all);
    });
  }

  it("walks the picker the same way", async () => {
    const all = await remaining({ OR: [{ tripId: null }, { tripId: { not: otherTrip } }] }, [{ takenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }]);
    const seen = await walk((cursor) => candidatePhotoPage({ kind: "trip", id: otherTrip }, NO_PICKER_FILTER, { cursor, take: 5 }), (id) => db.photo.update({ where: { id }, data: { trashedAt: new Date() } }));
    expect(seen).toEqual(all);
  });

  it("still follows a cursor that is only an id, from a page opened before the change", async () => {
    const first = await unassigned(null);
    const legacy = first.photos[first.photos.length - 1].id;
    const next = await unassignedPhotoPage(NO_FILTER, { cursor: legacy, take: 4 });
    const all = await remaining({ tripId: null }, unassignedOrder);
    expect(next.photos.map((p) => p.id)).toEqual(all.slice(4, 8));
  });

  it("reads no more than a page and one more to know there is another", async () => {
    const spy = vi.spyOn(db.photo, "findMany");
    await unassigned(null);
    await tripPhotoPage(tripId, { take: 4, order: "taken" });
    const read = await Promise.all(spy.mock.results.map((r) => r.value as Promise<unknown[]>));
    expect(read.length).toBe(2);
    for (const rows of read) expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("writes a position that reads back as itself, an empty date included", () => {
    const columns: KeyColumn[] = [{ field: "takenAt", dir: "asc", nullsLast: true }, { field: "createdAt", dir: "asc" }];
    const created = new Date("2025-09-01T00:00:00.123Z");
    expect(decodeCursor(encodeCursor({ id: "abc", takenAt: null, createdAt: created }, columns), columns)).toEqual({ values: [null, created], id: "abc" });
    expect(decodeCursor("abc", columns)).toBeNull();
    expect(decodeCursor("x.1.abc", columns)).toBeNull();
  });

  it("turns away a cursor whose date is too far off to be one, rather than failing the request", async () => {
    const columns: KeyColumn[] = [{ field: "createdAt", dir: "desc" }];
    const huge = "99999999999999999999.abc";
    expect(decodeCursor(huge, columns)).toBeNull();
    expect(decodeCursor("8640000000000001.abc", columns)).toBeNull();
    // Taken for an old id-only cursor that matches nothing, so the gallery simply has nothing more.
    await expect(unassignedPhotoPage(NO_FILTER, { cursor: huge, take: 4 })).resolves.toMatchObject({ photos: [], nextCursor: null });
  });

  it("finds an id-only cursor's place only among what the list shows, so it cannot borrow a hidden photo's date", async () => {
    // A photograph on another trip, taken in the middle of this one's: anchoring on it would say when it was taken.
    const hidden = await db.photo.create({ data: { ...base(), originalName: "hidden.jpg", tripId: otherTrip, takenAt: new Date(Date.UTC(2025, 7, 11, 12, 1, 30)) } });
    const visible = await tripPhotoPage(tripId, { take: 50, order: "taken" });
    expect(visible.photos.length).toBeGreaterThan(4);
    // Treated as a place that has gone: nowhere to continue from, the same answer as an id that never existed.
    expect(await tripPhotoPage(tripId, { cursor: hidden.id, take: 50, order: "taken", readyOnly: true })).toMatchObject({ photos: [], nextCursor: null });
    expect(await tripPhotoPage(tripId, { cursor: "no-such-photo", take: 50, order: "taken", readyOnly: true })).toMatchObject({ photos: [], nextCursor: null });
    // Nor one of the trip's own that this viewer is not shown: a visitor sees finished items only.
    const pending = await db.photo.create({ data: { ...base(), originalName: "pending.jpg", tripId, status: "PROCESSING", takenAt: new Date(Date.UTC(2025, 7, 11, 12, 1, 30)) } });
    expect(await tripPhotoPage(tripId, { cursor: pending.id, take: 50, order: "taken", readyOnly: true })).toMatchObject({ photos: [], nextCursor: null });
    // One it does show still works, as it always did.
    const at = visible.photos[1].id;
    expect((await tripPhotoPage(tripId, { cursor: at, take: 50, order: "taken", readyOnly: true })).photos.map((p) => p.id)).toEqual(visible.photos.slice(2).map((p) => p.id));
  });

  it("reads a favourites-first cursor as a whole number of rows, and anything else as the first page", async () => {
    expect([offsetCursor(null), offsetCursor("240"), offsetCursor("-1"), offsetCursor("0.5"), offsetCursor("2.9"), offsetCursor("abc"), offsetCursor("1e30"), offsetCursor("Infinity")]).toEqual([0, 240, 0, 0, 2, 0, 0, 0]);
    const first = await tripPhotoPage(tripId, { take: 4 });
    for (const cursor of ["-1", "0.5", "1e30"]) {
      await expect(tripPhotoPage(tripId, { cursor, take: 4 })).resolves.toMatchObject({ photos: first.photos });
    }
  });
});
