import { describe, expect, it } from "vitest";
import { buildTimeline, photosOnDay } from "@/lib/timeline/build";

const p = (id: string, iso: string | null, activityId: string | null = null, tzOffsetMin: number | null = -240) => ({ id, takenAt: iso ? new Date(iso) : null, tzOffsetMin, activityId });
const a = (id: string, s: string, e: string) => ({ id, startTime: new Date(s), endTime: new Date(e) });

describe("buildTimeline", () => {
  it("groups by local day and batches loose photos around activities", () => {
    const acts = [a("hike", "2025-08-12T13:00:00Z", "2025-08-12T17:00:00Z")];
    const photos = [
      p("breakfast", "2025-08-12T11:30:00Z"),
      p("coffee", "2025-08-12T11:45:00Z"),
      p("trail", "2025-08-12T14:00:00Z", "hike"),
      p("dinner", "2025-08-12T23:30:00Z"),
      p("late", "2025-08-13T02:30:00Z"), // 22:30 local on the 12th
      p("next", "2025-08-13T13:00:00Z"),
    ];
    const groups = buildTimeline(photos, acts, "America/New_York");
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-08-12", "2025-08-13"]);
    const day1 = groups[0].items;
    expect(day1.map((i) => i.kind)).toEqual(["photos", "activity", "photos"]);
    expect(day1[0].kind === "photos" && day1[0].photos.map((x) => x.id)).toEqual(["breakfast", "coffee"]);
    expect(day1[1].kind === "activity" && day1[1].photos.map((x) => x.id)).toEqual(["trail"]);
    expect(day1[2].kind === "photos" && day1[2].photos.map((x) => x.id)).toEqual(["dinner", "late"]);
  });

  it("uses the trip zone when a photo has no offset and puts undated photos last", () => {
    const groups = buildTimeline([p("x", "2025-08-13T02:30:00Z", null, null), p("nodate", null)], [], "Asia/Tokyo");
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-08-13", null]);
    expect(groups[1].items[0].kind === "photos" && groups[1].items[0].photos[0].id).toBe("nodate");
  });

  it("treats photos linked to a missing activity as loose", () => {
    const groups = buildTimeline([p("orphan", "2025-08-12T12:00:00Z", "gone")], [], "UTC");
    expect(groups[0].items[0].kind).toBe("photos");
  });

  it("orders activities by start time within a day", () => {
    const acts = [a("late", "2025-08-12T18:00:00Z", "2025-08-12T19:00:00Z"), a("early", "2025-08-12T08:00:00Z", "2025-08-12T09:00:00Z")];
    const groups = buildTimeline([], acts, "UTC");
    expect(groups[0].items.map((i) => (i.kind === "activity" ? i.activity.id : "?"))).toEqual(["early", "late"]);
  });
});

describe("photographs whose offsets disagree with the trip zone", () => {
  it("keeps one group per day, in day order, however the offsets interleave (#60)", () => {
    const photos = [
      p("a", "2025-08-12T04:30:00Z", null, -240), // Aug 12 00:30 on New York time
      p("b", "2025-08-12T04:45:00Z", null, -300), // Aug 11 23:45 on Chicago time
      p("c", "2025-08-12T05:00:00Z", null, -240), // Aug 12 01:00
    ];
    const groups = buildTimeline(photos, [], "America/New_York");
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-08-11", "2025-08-12"]);
    expect(groups[1].items.flatMap((i) => i.photos.map((x) => x.id))).toEqual(["a", "c"]);
    expect(groups[1].items).toHaveLength(1);
  });

  it("files an activity under its trip-zone day alongside a photograph on another clock", () => {
    const acts = [a("drive", "2025-08-12T04:10:00Z", "2025-08-12T06:00:00Z")]; // Aug 12 00:10 New York
    const photos = [p("chi", "2025-08-12T04:20:00Z", null, -300), p("ny", "2025-08-12T04:40:00Z", null, -240)];
    const groups = buildTimeline(photos, acts, "America/New_York");
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-08-11", "2025-08-12"]);
    expect(groups[1].items.map((i) => i.kind)).toEqual(["activity", "photos"]);
    expect(new Set(groups.map((g) => g.dayKey)).size).toBe(groups.length);
  });
});

describe("counting a day's photographs", () => {
  it("counts the ones on its activities as well as the loose ones, not one per activity", () => {
    const acts = [a("hike", "2025-08-12T13:00:00Z", "2025-08-12T17:00:00Z"), a("swim", "2025-08-12T18:00:00Z", "2025-08-12T19:00:00Z")];
    const photos = [p("breakfast", "2025-08-12T11:30:00Z"), p("t1", "2025-08-12T14:00:00Z", "hike"), p("t2", "2025-08-12T14:10:00Z", "hike"), p("t3", "2025-08-12T14:20:00Z", "hike")];
    const [day] = buildTimeline(photos, acts, "America/New_York");
    // Three on the walk, one at breakfast; the swim with nothing on it adds nothing.
    expect(photosOnDay(day)).toBe(4);
  });
});

describe("buildTimeline, an activity that runs past midnight", () => {
  // A ride from 22:30 on the 12th to 01:15 on the 13th in New York.
  const ride = a("ride", "2025-08-13T02:30:00Z", "2025-08-13T05:15:00Z");

  it("stays under the day it began, and the next day opens with a pointer back to it", () => {
    const photos = [p("dusk", "2025-08-13T02:45:00Z", "ride"), p("after-midnight", "2025-08-13T04:40:00Z", "ride"), p("breakfast", "2025-08-13T12:00:00Z")];
    const groups = buildTimeline(photos, [ride], "America/New_York");
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-08-12", "2025-08-13"]);
    expect(groups[0].items.map((i) => i.kind)).toEqual(["activity"]);
    expect(groups[0].items[0].photos.map((x) => x.id)).toEqual(["dusk", "after-midnight"]);
    const next = groups[1].items;
    expect(next.map((i) => i.kind)).toEqual(["continued", "photos"]);
    expect(next[0]).toMatchObject({ kind: "continued", from: "2025-08-12", activity: { id: "ride" }, photos: [] });
    // Its photographs are counted once, under the day it began.
    expect(groups.map(photosOnDay)).toEqual([2, 1]);
  });

  it("makes up no day to hold the pointer, and points from no day for a ride ending on the stroke of midnight", () => {
    expect(buildTimeline([p("after-midnight", "2025-08-13T04:40:00Z", "ride")], [ride], "America/New_York").map((g) => g.dayKey)).toEqual(["2025-08-12"]);
    const toMidnight = a("evening", "2025-08-13T02:30:00Z", "2025-08-13T04:00:00Z");
    const groups = buildTimeline([p("breakfast", "2025-08-13T12:00:00Z")], [toMidnight], "America/New_York");
    expect(groups[1].items.map((i) => i.kind)).toEqual(["photos"]);
  });

  it("points back from every later day of a trek several days long", () => {
    const trek = a("trek", "2025-08-12T12:00:00Z", "2025-08-15T20:00:00Z");
    const photos = ["2025-08-13T15:00:00Z", "2025-08-14T15:00:00Z", "2025-08-16T15:00:00Z"].map((iso, i) => p(`day${i}`, iso));
    const groups = buildTimeline(photos, [trek], "America/New_York");
    expect(groups.map((g) => [g.dayKey, g.items.map((i) => i.kind).join(",")])).toEqual([
      ["2025-08-12", "activity"],
      ["2025-08-13", "continued,photos"],
      ["2025-08-14", "continued,photos"],
      ["2025-08-16", "photos"],
    ]);
  });
});
