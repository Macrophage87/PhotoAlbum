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

  it("pages the timeline at day boundaries and links the following page", async () => {
    const first = await tripTimeline(tripId, "UTC", { limit: 15 });
    expect(first.groups.map((g) => g.dayKey)).toEqual(["2025-08-10"]); // the partial second day waits for the next page
    expect(first.nextAfter).not.toBeNull();
    const second = await tripTimeline(tripId, "UTC", { after: first.nextAfter, limit: 15 });
    expect(second.groups.map((g) => g.dayKey)).toEqual(["2025-08-11", "2025-08-12"]);
    expect(second.nextAfter).toBeNull();
  });
});
