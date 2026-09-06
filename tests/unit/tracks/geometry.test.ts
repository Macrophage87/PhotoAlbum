import { describe, expect, it } from "vitest";
import { simplifyLine } from "@/lib/tracks/simplify";
import { columnarToPoints, decodePoints, encodePoints } from "@/lib/tracks/encode";
import { splitByLocalDay } from "@/lib/tracks/split";
import { positionAt } from "@/lib/tracks/interpolate";
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
