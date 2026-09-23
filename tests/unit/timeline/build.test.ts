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

describe("counting a day's photographs", () => {
  it("counts the ones on its activities as well as the loose ones, not one per activity", () => {
    const acts = [a("hike", "2025-08-12T13:00:00Z", "2025-08-12T17:00:00Z"), a("swim", "2025-08-12T18:00:00Z", "2025-08-12T19:00:00Z")];
    const photos = [p("breakfast", "2025-08-12T11:30:00Z"), p("t1", "2025-08-12T14:00:00Z", "hike"), p("t2", "2025-08-12T14:10:00Z", "hike"), p("t3", "2025-08-12T14:20:00Z", "hike")];
    const [day] = buildTimeline(photos, acts, "America/New_York");
    // Three on the walk, one at breakfast; the swim with nothing on it adds nothing.
    expect(photosOnDay(day)).toBe(4);
  });
});
