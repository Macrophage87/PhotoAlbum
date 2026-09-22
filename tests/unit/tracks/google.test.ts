import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGoogleFormat, parseGoogleExport } from "@/lib/tracks/google";
import { parseLatLng, parseTime } from "@/lib/tracks/google/common";

const fx = (n: string) => path.join(__dirname, "../../fixtures", n);
const window = { startMs: Date.parse("2025-08-10T04:00:00Z"), endMs: Date.parse("2025-08-17T03:59:59Z") };

describe("google detect", () => {
  it("recognizes every export shape", () => {
    expect(detectGoogleFormat(readFileSync(fx("google-records.json"), "utf8"))).toBe("records");
    expect(detectGoogleFormat(readFileSync(fx("google-timeline-android.json"), "utf8"))).toBe("timeline-android");
    expect(detectGoogleFormat(readFileSync(fx("google-timeline-ios.json"), "utf8"))).toBe("timeline-ios");
    expect(detectGoogleFormat(readFileSync(fx("google-semantic.json"), "utf8"))).toBe("semantic");
    expect(detectGoogleFormat('{"foo":1}')).toBeNull();
  });
  it("parses coordinate and time strings", () => {
    expect(parseLatLng("44.3530°, -68.2030°")).toEqual([44.353, -68.203]);
    expect(parseLatLng("geo:44.35,-68.2")).toEqual([44.35, -68.2]);
    expect(parseTime("1755000000000")).toBe(1755000000000);
    expect(parseTime("2025-08-12T14:00:00Z")).toBe(Date.parse("2025-08-12T14:00:00Z"));
  });
});

describe("google parsers", () => {
  it("Records.json: filters by window and accuracy, keeps altitude", async () => {
    const { format, points } = await parseGoogleExport(fx("google-records.json"), window);
    expect(format).toBe("records");
    expect(points.map((p) => p.lat)).toEqual([44.35, 44.351, 44.353, 44.354]);
    expect(points[1].ele).toBe(40);
  });
  it("Android Timeline.json: paths, visits and activities", async () => {
    const { points } = await parseGoogleExport(fx("google-timeline-android.json"), window);
    // 3 path points + visit start/end + activity start/end = 7, NYC segment excluded
    expect(points).toHaveLength(7);
    expect(points[1].t).toBe(Date.parse("2025-08-12T14:05:00Z"));
    expect(points.every((p) => p.lat > 44)).toBe(true);
  });
  it("iOS export (top-level array) yields the same points", async () => {
    const a = await parseGoogleExport(fx("google-timeline-android.json"), window);
    const b = await parseGoogleExport(fx("google-timeline-ios.json"), window);
    expect(b.format).toBe("timeline-ios");
    expect(b.points).toEqual(a.points);
  });
  it("Semantic Location History: raw paths preferred, waypoints spread over time", async () => {
    const { points } = await parseGoogleExport(fx("google-semantic.json"), window);
    // segment 1: start + waypoint + end = 3 spread over 10 min; visit 2; raw path 2 => 7
    expect(points).toHaveLength(7);
    expect(points[1].t).toBe(Date.parse("2025-08-12T14:05:00Z"));
    expect(points[1].lat).toBeCloseTo(44.351, 6);
  });
});
