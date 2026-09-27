import { describe, expect, it } from "vitest";
import { simplifyLine } from "@/lib/tracks/simplify";
import { columnarToPoints, decodePoints, encodePoints } from "@/lib/tracks/encode";
import { splitByLocalDay } from "@/lib/tracks/split";
import { positionAt, positionKindAt } from "@/lib/tracks/interpolate";
import { detectTrackKind } from "@/lib/tracks/detect";
import { cleanPoints } from "@/lib/tracks/clean";
import type { TrackPoint } from "@/lib/tracks/types";

describe("simplifyLine", () => {
  it("collapses a straight line to its endpoints", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ lat: 44 + i * 0.0001, lng: -68 }));
    expect(simplifyLine(pts, 5).line).toHaveLength(2);
  });
  it("keeps corners", () => {
    const pts = [{ lat: 44, lng: -68 }, { lat: 44.001, lng: -68 }, { lat: 44.001, lng: -68.001 }, { lat: 44.002, lng: -68.001 }];
    expect(simplifyLine(pts, 5).line).toHaveLength(4);
  });
  it("respects the vertex cap", () => {
    const pts = Array.from({ length: 20000 }, (_, i) => ({ lat: 44 + 0.01 * Math.sin(i / 3), lng: -68 + i * 0.0001 }));
    const { line } = simplifyLine(pts, 0.01, 500);
    expect(line.length).toBeLessThanOrEqual(500);
    expect(line[0]).toEqual([44, -68]);
  });
});

describe("encodePoints", () => {
  it("round-trips through the columnar blob", () => {
    const pts: TrackPoint[] = [
      { t: 1_700_000_000_000, lat: 44.123456, lng: -68.654321, ele: 12.34, hr: 120 },
      { t: 1_700_000_005_000, lat: 44.123556, lng: -68.654421, hr: 121 },
      { t: 1_700_000_010_500, lat: 44.123656, lng: -68.654521, ele: 13, hr: 122, cad: 80 },
    ];
    const { blob, startTime, endTime, flags } = encodePoints(pts);
    expect(startTime.getTime()).toBe(pts[0].t);
    expect(endTime.getTime()).toBe(pts[2].t);
    expect(flags).toEqual({ ele: true, hr: true, cad: true, pwr: false });
    const col = decodePoints(blob);
    expect(col.t).toEqual([0, 5, 10.5]);
    expect(col.ele).toEqual([12.3, null, 13]);
    const back = columnarToPoints(col, startTime);
    expect(back[1].ele).toBeUndefined();
    expect(back[2].cad).toBe(80);
    expect(back[2].t).toBe(pts[2].t);
  });
});

describe("splitByLocalDay", () => {
  it("splits across a local midnight in the trip zone", () => {
    const pts: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:30:00Z"), lat: 44, lng: -68 }, // 23:30 on the 12th in New York
      { t: Date.parse("2025-08-13T04:30:00Z"), lat: 44, lng: -68 }, // 00:30 on the 13th
      { t: Date.parse("2025-08-13T12:00:00Z"), lat: 44, lng: -68 },
    ];
    const m = splitByLocalDay(pts, "America/New_York");
    expect([...m.keys()]).toEqual(["2025-08-12", "2025-08-13"]);
    expect(m.get("2025-08-13")).toHaveLength(2);
    expect([...splitByLocalDay(pts, "Asia/Kolkata").keys()]).toEqual(["2025-08-13"]);
    expect(splitByLocalDay(pts, "Asia/Kolkata").get("2025-08-13")).toHaveLength(3);
  });

  it("ends each day on the next day's first point, so the stretch across midnight is covered (#120)", () => {
    const pts: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:40:00Z"), lat: 43.99, lng: -68 }, // 23:40 on the 12th in New York
      { t: Date.parse("2025-08-13T03:55:00Z"), lat: 44, lng: -68 }, // 23:55
      { t: Date.parse("2025-08-13T04:04:00Z"), lat: 44.01, lng: -68 }, // 00:04 on the 13th
      { t: Date.parse("2025-08-13T05:00:00Z"), lat: 44.02, lng: -68 },
    ];
    const m = splitByLocalDay(pts, "America/New_York");
    const day1 = m.get("2025-08-12")!;
    // Close enough to interpolate across: joined at midnight (the last instant before it, then midnight itself).
    const midnight = Date.parse("2025-08-13T04:00:00Z");
    expect(day1.map((p) => p.t)).toEqual([pts[0].t, pts[1].t, midnight - 1]);
    expect(m.get("2025-08-13")!.map((p) => p.t)).toEqual([midnight, pts[2].t, pts[3].t]);
    // A photograph at 23:59 now falls inside the first day's track and is interpolated across the gap.
    const at = Date.parse("2025-08-13T03:59:00Z");
    expect(at).toBeLessThanOrEqual(day1[day1.length - 1].t);
    expect(positionAt(day1, at)?.lat).toBeCloseTo(44 + 0.01 * (4 / 9), 6);
  });

  it("ends a day on the next day's first point across a gap only within the snap window (#120)", () => {
    const pts: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:40:00Z"), lat: 43.99, lng: -68 }, // 23:40 on the 12th in New York
      { t: Date.parse("2025-08-13T03:52:00Z"), lat: 44, lng: -68 }, // 23:52
      { t: Date.parse("2025-08-13T04:04:00Z"), lat: 44.01, lng: -68 }, // 00:04 on the 13th: 12 minutes on
      { t: Date.parse("2025-08-13T05:00:00Z"), lat: 44.02, lng: -68 },
    ];
    const m = splitByLocalDay(pts, "America/New_York");
    const day1 = m.get("2025-08-12")!;
    expect(day1.map((p) => p.t)).toEqual([pts[0].t, pts[1].t, pts[2].t]);
    expect(m.get("2025-08-13")!.map((p) => p.t)).toEqual([pts[2].t, pts[3].t]);
    // A photograph at 23:59 is inside the first day's track, and snaps to the nearer side of the gap.
    expect(positionAt(day1, Date.parse("2025-08-13T03:59:00Z"))?.lat).toBe(44.01);
  });

  it("draws no connector across a long gap or from a day of a single point", () => {
    const night: TrackPoint[] = [
      { t: Date.parse("2025-08-13T02:00:00Z"), lat: 40.7, lng: -74 }, // 22:00 in New York
      { t: Date.parse("2025-08-13T03:00:00Z"), lat: 40.7, lng: -74 }, // 23:00
      { t: Date.parse("2025-08-13T12:00:00Z"), lat: 34, lng: -118 }, // 08:00 the next day, across the country
      { t: Date.parse("2025-08-13T12:10:00Z"), lat: 34, lng: -118 },
    ];
    expect(splitByLocalDay(night, "America/New_York").get("2025-08-12")).toHaveLength(2);
    const lone: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:50:00Z"), lat: 44, lng: -68 }, // 23:50, the day's only point
      { t: Date.parse("2025-08-13T04:03:00Z"), lat: 44, lng: -68 }, // 13 minutes on: too far to join at midnight
      { t: Date.parse("2025-08-13T04:10:00Z"), lat: 44, lng: -68 },
    ];
    expect(splitByLocalDay(lone, "America/New_York").get("2025-08-12")).toHaveLength(1);
  });
});

describe("positionAt", () => {
  const pts: TrackPoint[] = [
    { t: 0, lat: 44, lng: -68, ele: 100 },
    { t: 60_000, lat: 44.001, lng: -68.001, ele: 110 },
    { t: 60_000 + 20 * 60_000, lat: 44.002, lng: -68.002 }, // 20-minute gap
    { t: 60_000 + 21 * 60_000, lat: 44.003, lng: -68.003 },
  ];
  it("interpolates inside short gaps", () => {
    const p = positionAt(pts, 30_000)!;
    expect(p.lat).toBeCloseTo(44.0005, 6);
    expect(p.ele).toBeCloseTo(105, 6);
  });
  it("snaps to the nearer point when the gap is long but the point is close", () => {
    const p = positionAt(pts, 60_000 + 2 * 60_000)!;
    expect(p.lat).toBeCloseTo(44.001, 6);
  });
  it("returns null in the middle of a long gap and outside the track", () => {
    expect(positionAt(pts, 60_000 + 10 * 60_000)).toBeNull();
    expect(positionAt(pts, -1)).toBeNull();
    expect(positionAt(pts, 10 ** 9)).toBeNull();
  });
  it("places a photo taken while the ride was auto-paused at the stop, however long it was", () => {
    const H = 3_600_000;
    // A café 30 m on from where the computer paused, left two hours later; then a gap of a kilometre.
    const stop: TrackPoint[] = [
      { t: 0, lat: 44, lng: -68 },
      { t: 2 * H, lat: 44.0002, lng: -68.0002 },
      { t: 3 * H, lat: 44.01, lng: -68 },
      { t: 3 * H + 13 * H, lat: 44.01, lng: -68 },
    ];
    expect(positionAt(stop, H)).toMatchObject({ lat: 44.0001, lng: -68.0001 });
    expect(positionKindAt(stop, H)).toBe("firm");
    // A long gap between places apart is still no answer, and neither is a "stop" of more than 12 hours.
    expect(positionAt(stop, 2.5 * H)).toBeNull();
    expect(positionAt(stop, 9 * H)).toBeNull();
    expect(positionKindAt(stop, 9 * H)).toBeNull();
  });
});

describe("detectTrackKind / cleanPoints", () => {
  it("uses extension then content", () => {
    expect(detectTrackKind("ride.GPX", Buffer.from(""))).toBe("gpx");
    expect(detectTrackKind("x", Buffer.from("........" + ".FIT"))).toBe("fit");
    expect(detectTrackKind("x", Buffer.from('<?xml version="1.0"?><gpx>'))).toBe("gpx");
    expect(detectTrackKind("x", Buffer.from("  {"))).toBe("google");
    expect(detectTrackKind("x", Buffer.from("hello"))).toBeNull();
    expect(detectTrackKind("x", Buffer.from("hello"), "fit")).toBe("fit");
  });
  it("sorts, dedupes and drops invalid points", () => {
    const out = cleanPoints([
      { t: 2, lat: 1, lng: 1 },
      { t: 1, lat: 1, lng: 1 },
      { t: 2, lat: 1, lng: 1 },
      { t: 3, lat: 0, lng: 0 },
      { t: NaN, lat: 1, lng: 1 },
    ]);
    expect(out.map((p) => p.t)).toEqual([1, 2]);
  });
});

describe("splitByLocalDay across a midnight", () => {
  it("ends the day on the last instant before midnight and starts the next at midnight, when close enough", () => {
    // Two recorded points on each side: a day of only one is left as it is (see below).
    const pts: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:50:00Z"), lat: 43.99, lng: -68 }, // 23:50 in New York
      { t: Date.parse("2025-08-13T03:55:00Z"), lat: 44, lng: -68 }, // 23:55
      { t: Date.parse("2025-08-13T04:05:00Z"), lat: 44.01, lng: -68 }, // 00:05
      { t: Date.parse("2025-08-13T04:10:00Z"), lat: 44.02, lng: -68 }, // 00:10
    ];
    const m = splitByLocalDay(pts, "America/New_York");
    const day1 = m.get("2025-08-12")!, day2 = m.get("2025-08-13")!;
    const midnight = Date.parse("2025-08-13T04:00:00Z");
    expect(day1.map((p) => p.t)).toEqual([pts[0].t, pts[1].t, midnight - 1]);
    expect(day2.map((p) => p.t)).toEqual([midnight, pts[2].t, pts[3].t]);
    expect(day2[0].lat).toBeCloseTo(44.005, 6);
    expect(positionAt(day1, midnight - 1000)).not.toBeNull();
  });
  it("leaves a day of one recorded point as that point, though a point was worked out at midnight beside it", () => {
    const midnight = Date.parse("2025-08-13T04:00:00Z");
    const before: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:58:00Z"), lat: 44, lng: -68 }, // 23:58, the day's only point
      { t: Date.parse("2025-08-13T04:03:00Z"), lat: 44.01, lng: -68 }, // 00:03: close enough to join at midnight
      { t: Date.parse("2025-08-13T04:30:00Z"), lat: 44.02, lng: -68 },
    ];
    const m = splitByLocalDay(before, "America/New_York");
    // Not a two-minute track of the stretch to midnight: one point, which the importer skips.
    expect(m.get("2025-08-12")!.map((p) => p.t)).toEqual([before[0].t]);
    // The next day still begins at midnight, between the two recorded points either side of it.
    expect(m.get("2025-08-13")!.map((p) => p.t)).toEqual([midnight, before[1].t, before[2].t]);

    const after: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:30:00Z"), lat: 44, lng: -68 },
      { t: Date.parse("2025-08-13T03:57:00Z"), lat: 44.01, lng: -68 }, // 23:57
      { t: Date.parse("2025-08-13T04:02:00Z"), lat: 44.02, lng: -68 }, // 00:02, the next day's only point
    ];
    const n = splitByLocalDay(after, "America/New_York");
    // The day before reaches midnight as usual and, the next day being a point the importer skips, runs on to that
    // point (within the snap window), so the minutes after midnight still belong to a track.
    expect(n.get("2025-08-12")!.map((p) => p.t)).toEqual([after[0].t, after[1].t, midnight - 1, after[2].t]);
    expect(n.get("2025-08-13")!.map((p) => p.t)).toEqual([after[2].t]);
    // Nothing worked out is left on either one-point day.
    expect([...m.values(), ...n.values()].flat().filter((p) => p.filled === "interpolated").map((p) => p.t)).toEqual([midnight, midnight - 1]);
  });
  it("leaves a long gap across midnight as it is", () => {
    const pts: TrackPoint[] = [
      { t: Date.parse("2025-08-13T03:30:00Z"), lat: 44, lng: -68 },
      { t: Date.parse("2025-08-13T04:30:00Z"), lat: 44, lng: -68 },
    ];
    const m = splitByLocalDay(pts, "America/New_York");
    expect([...m.values()].map((d) => d.length)).toEqual([1, 1]);
  });
});

describe("filled points in the stored blob", () => {
  it("round-trip with their kind, and older blobs without the column read as recorded", () => {
    const pts: TrackPoint[] = [{ t: 0, lat: 44, lng: -68 }, { t: 60_000, lat: 44.001, lng: -68, filled: "visit" }, { t: 120_000, lat: 44.002, lng: -68, filled: "interpolated" }];
    const { blob, startTime } = encodePoints(pts);
    expect(columnarToPoints(decodePoints(blob), startTime).map((p) => p.filled)).toEqual([undefined, "visit", "interpolated"]);
    const old = encodePoints([{ t: 0, lat: 44, lng: -68 }, { t: 60_000, lat: 44.001, lng: -68 }]);
    expect(decodePoints(old.blob).filled).toBeUndefined();
    expect(columnarToPoints(decodePoints(old.blob), old.startTime).some((p) => p.filled)).toBe(false);
  });
  it("positionKindAt tells recorded, visit and guessed positions apart", () => {
    const M = 60_000;
    const pts: TrackPoint[] = [
      { t: 0, lat: 0, lng: 0 },
      { t: 8 * M, lat: 0, lng: 0 }, // 8 minutes after the first: still interpolated between recorded fixes
      { t: 40 * M, lat: 0.01, lng: 0 }, // a 32-minute signal gap before this one, a kilometre on
      { t: 45 * M, lat: 0.01, lng: 0, filled: "visit" },
      { t: 50 * M, lat: 0.01, lng: 0, filled: "visit" },
      { t: 55 * M, lat: 0.01, lng: 0, filled: "interpolated" },
    ];
    expect(positionKindAt(pts, 4 * M)).toBe("firm");
    expect(positionKindAt(pts, 8 * M)).toBe("firm");
    expect(positionKindAt(pts, 11 * M)).toBe("soft"); // snapped across the gap
    expect(positionKindAt(pts, 24 * M)).toBeNull();
    expect(positionKindAt(pts, 47 * M)).toBe("visit");
    expect(positionKindAt(pts, 52 * M)).toBe("soft");
  });
});

describe("splitByLocalDay labels its midnight points", () => {
  it("as the visit between two visit points, and as the importer's own guess anywhere else", () => {
    const at = (iso: string, filled?: "visit") => ({ t: Date.parse(iso), lat: 44, lng: -68, ...(filled ? { filled } : {}) });
    // Two points on each side of midnight: a day of only one keeps nothing worked out beside it.
    const inVisit = [...splitByLocalDay([at("2025-08-13T03:52:00Z", "visit"), at("2025-08-13T03:57:00Z", "visit"), at("2025-08-13T04:02:00Z", "visit"), at("2025-08-13T04:07:00Z", "visit")], "America/New_York").values()].flat();
    expect(inVisit.filter((p) => p.t === Date.parse("2025-08-13T04:00:00Z")).map((p) => p.filled)).toEqual(["visit"]);
    const recorded = [...splitByLocalDay([at("2025-08-13T03:52:00Z"), at("2025-08-13T03:57:00Z"), at("2025-08-13T04:02:00Z"), at("2025-08-13T04:07:00Z")], "America/New_York").values()].flat();
    expect(recorded.filter((p) => p.t === Date.parse("2025-08-13T04:00:00Z")).map((p) => p.filled)).toEqual(["interpolated"]);
  });
});
