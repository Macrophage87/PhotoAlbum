import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { unassignedPhotoPage } from "@/lib/photos/queries";
import { NO_FILTER } from "@/lib/photos/filters";
import { resetTestDb } from "../helpers/reset";

describe("photos without a trip, a page at a time", () => {
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "u@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const base = { uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
    // Several share an upload moment, as a Takeout import's do, so the order has to fall back on the id.
    await db.photo.createMany({ data: Array.from({ length: 11 }, (_, i) => ({ ...base, originalName: `${i % 2 ? "dog" : "cat"}-${i}.jpg`, createdAt: new Date(Date.UTC(2025, 0, 1, 0, Math.floor(i / 3))) })) });
    await db.photo.create({ data: { ...base, tripId: trip.id, originalName: "dog-on-a-trip.jpg" } });
    await db.photo.create({ data: { ...base, originalName: "dog-binned.jpg", trashedAt: new Date() } });
  });

  it("walks every one of them, newest upload first, without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await unassignedPhotoPage(NO_FILTER, { cursor, take: 4 });
      expect(page.photos.length).toBeLessThanOrEqual(4);
      expect(page.total).toBe(11);
      expect(page.matched).toBe(11);
      seen.push(...page.photos.map((p) => p.originalName));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(11);
    const all = await db.photo.findMany({ where: { tripId: null, trashedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { originalName: true } });
    expect(seen).toEqual(all.map((p) => p.originalName));
  });

  it("pages a search the same way, and counts what it matches beside how many there are", async () => {
    const first = await unassignedPhotoPage({ ...NO_FILTER, q: "dog" }, { take: 3 });
    expect(first.matched).toBe(5);
    expect(first.total).toBe(11);
    const rest = await unassignedPhotoPage({ ...NO_FILTER, q: "dog" }, { take: 3, cursor: first.nextCursor });
    expect(rest.nextCursor).toBeNull();
    expect([...first.photos, ...rest.photos].map((p) => p.originalName).every((n) => n.startsWith("dog-") && n !== "dog-on-a-trip.jpg" && n !== "dog-binned.jpg")).toBe(true);
    expect(first.photos.length + rest.photos.length).toBe(5);
  });

  it("answers a search with no matches without paging at all", async () => {
    const page = await unassignedPhotoPage({ ...NO_FILTER, q: "zzqq" });
    expect(page).toMatchObject({ photos: [], nextCursor: null, matched: 0, total: 11 });
  });
});
