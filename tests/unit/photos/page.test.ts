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
