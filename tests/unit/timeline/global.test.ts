import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { timelineCounts, timelineIds, tripTimeline } from "@/lib/timeline/queries";
import { NO_FILTER } from "@/lib/photos/filters";
import { photosOnDay } from "@/lib/timeline/build";
import { timelinePage } from "@/lib/timeline/paging";
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
    // A member's search, as the admin who uploaded these would ask it: the trips are not public.
    const filter = { ...NO_FILTER, q: "lighthouse", member: true };
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
    const filter = { ...NO_FILTER, q: "zzqq", member: true };
    const ids = await timelineIds(filter, null);
    expect(ids).toEqual([]);
    expect((await timelineCounts([a, b, c], filter, ids)).size).toBe(0);
    expect((await tripTimeline(a, "UTC", filter, ids)).matched).toBe(0);
  });

  describe("a ride past midnight, on a page of the timeline of everything", () => {
    let ride: string, night: string;
    beforeEach(async () => {
      const user = await db.user.findFirstOrThrow();
      night = (await db.trip.create({ data: { slug: "night", title: "night", timezone: "America/New_York", startDate: new Date("2025-08-12"), endDate: new Date("2025-08-13"), createdById: user.id } })).id;
      // 22:30 on the 12th to 01:15 on the 13th in New York, with a photograph each side of midnight, and breakfast.
      ride = (await db.activity.create({ data: { tripId: night, title: "Night ride", type: "BIKE", startTime: new Date("2025-08-13T02:30:00Z"), endTime: new Date("2025-08-13T05:15:00Z") } })).id;
      const photo = (caption: string, at: string, activityId: string | null) => ({ tripId: night, activityId, uploaderId: user.id, originalName: `${caption}.jpg`, caption, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, takenAt: new Date(at), tzOffsetMin: -240 });
      await db.photo.createMany({ data: [photo("dusk ride", "2025-08-13T02:45:00Z", ride), photo("lighthouse by night", "2025-08-13T04:40:00Z", ride), photo("lighthouse breakfast", "2025-08-13T12:00:00Z", null)] });
    });

    const onItsPage = async (filter: typeof NO_FILTER) => {
      const trips = [{ id: night, timezone: "America/New_York" }, { id: a, timezone: "UTC" }, { id: b, timezone: "UTC" }, { id: c, timezone: "UTC" }];
      const searching = Boolean(filter.q);
      const restrict = searching ? await timelineIds(filter, null) : null;
      const counts = await timelineCounts(trips.map((t) => t.id), filter, restrict);
      const { onPage } = timelinePage(trips, counts, { searching, page: 1 });
      expect(onPage.map((t) => t.id)).toContain(night);
      return { count: counts.get(night), groups: (await tripTimeline(night, "America/New_York", filter, restrict)).groups };
    };

    it("keeps the ride under the day it began, points back from the next day, and counts each photograph once", async () => {
      const { count, groups } = await onItsPage(NO_FILTER);
      expect(groups.map((g) => [g.dayKey, g.items.map((i) => i.kind).join(",")])).toEqual([["2025-08-12", "activity"], ["2025-08-13", "continued,photos"]]);
      expect(groups[1].items[0]).toMatchObject({ kind: "continued", from: "2025-08-12", activity: { id: ride } });
      expect(groups.map(photosOnDay)).toEqual([2, 1]);
      expect(groups.map(photosOnDay).reduce((x, y) => x + y)).toBe(count);
    });

    it("still points back when a search narrows the page, and counts what matched", async () => {
      const { count, groups } = await onItsPage({ ...NO_FILTER, q: "lighthouse", member: true });
      expect(groups.map((g) => [g.dayKey, g.items.map((i) => i.kind).join(",")])).toEqual([["2025-08-12", "activity"], ["2025-08-13", "continued,photos"]]);
      expect(groups.map(photosOnDay)).toEqual([1, 1]);
      expect(count).toBe(2);
    });

    it("points back from nothing when the search leaves the later day empty", async () => {
      const { count, groups } = await onItsPage({ ...NO_FILTER, q: "dusk", member: true });
      expect(groups.map((g) => [g.dayKey, g.items.map((i) => i.kind).join(",")])).toEqual([["2025-08-12", "activity"]]);
      expect(count).toBe(1);
    });
  });
});
