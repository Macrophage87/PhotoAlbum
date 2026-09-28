import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/timeline/build";
import { orderTimeline, parseTimelineOrder, timeSpan } from "@/lib/timeline/order";

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

describe("the time span printed above a run of photographs", () => {
  it("reads earliest to latest whichever way the run is ordered", () => {
    const run = [p("a", "2025-08-12T09:00:00Z"), p("b", "2025-08-12T12:00:00Z"), p("c", "2025-08-12T15:30:00Z")];
    const [newest] = orderTimeline(buildTimeline(run, [], "UTC"), "newest");
    const span = timeSpan(newest.items[0].photos)!;
    expect(newest.items[0].photos[0].id).toBe("c");
    expect([span.first.id, span.last.id]).toEqual(["a", "c"]);
    expect(timeSpan([...run])).toMatchObject({ first: { id: "a" }, last: { id: "c" } });
  });

  it("is one moment for a single photograph and nothing for none with a date", () => {
    const one = timeSpan([p("a", "2025-08-12T09:00:00Z")])!;
    expect(one.first).toBe(one.last);
    expect(timeSpan([p("u", null)])).toBeNull();
  });
});
