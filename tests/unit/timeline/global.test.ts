import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { timelineCounts, timelineIds, tripTimeline } from "@/lib/timeline/queries";
import { NO_FILTER } from "@/lib/photos/filters";
import { resetTestDb } from "../helpers/reset";

describe("the timeline of everything", () => {
  let a: string, b: string, c: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "g@example.com", role: "ADMIN" } });
    const trip = async (slug: string) => (await db.trip.create({ data: { slug, title: slug, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } })).id;
    [a, b, c] = [await trip("a"), await trip("b"), await trip("c")];
    const photo = (tripId: string, caption: string, extra: Record<string, unknown> = {}) => ({ tripId, uploaderId: user.id, originalName: `${caption}.jpg`, caption, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, takenAt: new Date("2025-08-11T12:00:00Z"), tzOffsetMin: 0, ...extra });
    await db.photo.createMany({
      data: [
        photo(a, "lighthouse at dusk"), photo(a, "harbour"), photo(a, "gulls"),
        photo(b, "lighthouse again"), photo(b, "binned", { trashedAt: new Date() }), photo(b, "uploading", { status: "PENDING" }),
        // c has nothing at all: still a trip on the timeline, with nothing to count.
      ],
    });
  });

  it("counts every trip's photographs in one question, as the timeline would show them", async () => {
    const counts = await timelineCounts([a, b, c]);
    expect(counts.get(a)).toBe(3);
    // Neither the binned one nor the one still uploading is on a timeline.
    expect(counts.get(b)).toBe(1);
    expect(counts.has(c)).toBe(false);
  });

  it("asks a search of the whole album once and counts only the trips it found something on", async () => {
    const filter = { ...NO_FILTER, q: "lighthouse" };
    const ids = await timelineIds(filter, null);
    expect(ids).toHaveLength(2);
    const counts = await timelineCounts([a, b, c], filter, ids);
    expect(Object.fromEntries(counts)).toEqual({ [a]: 1, [b]: 1 });
    // And each trip's timeline, handed that same answer, keeps exactly what it would have found by itself.
    for (const trip of [a, b]) {
      const given = await tripTimeline(trip, "UTC", filter, ids);
      const own = await tripTimeline(trip, "UTC", filter);
      expect(given.matched).toBe(own.matched);
      expect(given.matched).toBe(counts.get(trip));
    }
  });

  it("says nothing matches without asking again when the search found nothing", async () => {
    const filter = { ...NO_FILTER, q: "zzqq" };
    const ids = await timelineIds(filter, null);
    expect(ids).toEqual([]);
    expect((await timelineCounts([a, b, c], filter, ids)).size).toBe(0);
    expect((await tripTimeline(a, "UTC", filter, ids)).matched).toBe(0);
  });
});
