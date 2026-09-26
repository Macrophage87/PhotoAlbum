import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/timeline/build";
import { orderTimeline, parseTimelineOrder } from "@/lib/timeline/order";

const p = (id: string, iso: string | null, activityId: string | null = null) => ({ id, takenAt: iso ? new Date(iso) : null, tzOffsetMin: 0, activityId });
const a = (id: string, s: string, e: string) => ({ id, startTime: new Date(s), endTime: new Date(e) });

describe("running a timeline newest first", () => {
  const photos = [
    p("breakfast", "2025-08-12T08:00:00Z"),
    p("coffee", "2025-08-12T08:30:00Z"),
    p("trail-1", "2025-08-12T14:00:00Z", "hike"),
    p("trail-2", "2025-08-12T15:00:00Z", "hike"),
    p("dinner", "2025-08-12T19:00:00Z"),
    p("next", "2025-08-13T10:00:00Z"),
    p("undated", null),
  ];
  const groups = buildTimeline(photos, [a("hike", "2025-08-12T13:00:00Z", "2025-08-12T16:00:00Z")], "UTC");

  it("leaves the usual order alone", () => {
    expect(orderTimeline(groups, "oldest")).toBe(groups);
  });

  it("puts the latest day first, and the latest moment first within each day, with the undated still last", () => {
    const newest = orderTimeline(groups, "newest");
    expect(newest.map((g) => g.dayKey)).toEqual(["2025-08-13", "2025-08-12", null]);
    const day = newest[1].items;
    expect(day.map((i) => (i.kind === "activity" ? "hike" : i.photos.map((x) => x.id).join(",")))).toEqual(["dinner", "hike", "coffee,breakfast"]);
    expect(day[1].photos.map((x) => x.id)).toEqual(["trail-2", "trail-1"]);
  });

  it("does not disturb the timeline it was given", () => {
    const before = JSON.stringify(groups);
    orderTimeline(groups, "newest");
    expect(JSON.stringify(groups)).toBe(before);
  });

  it("reads only the two words it knows", () => {
    expect(parseTimelineOrder("newest")).toBe("newest");
    expect(parseTimelineOrder("oldest")).toBe("oldest");
    expect(parseTimelineOrder("sideways")).toBeNull();
    expect(parseTimelineOrder(undefined)).toBeNull();
  });
});
