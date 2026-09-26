import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGoogleFormat, parseGoogleExport } from "@/lib/tracks/google";
import { parseLatLng, parseTime } from "@/lib/tracks/google/common";
import { timelineObjectToPoints, timelineObjectToStays } from "@/lib/tracks/google/semantic";
import { fillStays, STAY_STEP_MS } from "@/lib/tracks/google/stays";
import { segmentToPoints, segmentToStay } from "@/lib/tracks/google/timeline";
import { computeStats } from "@/lib/tracks/stats";
import { positionAt } from "@/lib/tracks/interpolate";

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
    // 3 path points + activity start/end, NYC segment excluded; the 55-minute visit fills the gap between them every
    // 5 min, except within 5 min of the path's last point (11)
    expect(points).toHaveLength(16);
    expect(points.filter((p) => !p.stay)).toHaveLength(5);
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
    // segment 1: start + waypoint + end = 3 spread over 10 min; raw path 2; the visit fills the gap between them 11
    expect(points).toHaveLength(16);
    expect(points[1].t).toBe(Date.parse("2025-08-12T14:05:00Z"));
    expect(points[1].lat).toBeCloseTo(44.351, 6);
  });
});

describe("google visits", () => {
  const at = (iso: string) => Date.parse(iso);
  type Seg = Parameters<typeof segmentToPoints>[0];
  const parse = (segs: Seg[], w = window) => fillStays(segs.flatMap((s) => segmentToPoints(s, w)), segs.map(segmentToStay).filter((s) => s !== null), w);
  const museum = (start: string, end: string, extra: Record<string, unknown> = {}): Seg => ({ startTime: start, endTime: end, visit: { topCandidate: { placeLocation: { latLng: "40.7794°, -73.9632°" } }, ...extra } });

  it("cover the whole stay, so a photo in the middle of a long visit is placed there", async () => {
    const pts = parse([museum("2025-08-12T14:00:00Z", "2025-08-12T17:00:00Z", { probability: 0.9 })]);
    expect(pts[0].t).toBe(at("2025-08-12T14:00:00Z"));
    expect(pts.at(-1)!.t).toBe(at("2025-08-12T17:00:00Z"));
    expect(pts.every((p) => p.stay)).toBe(true);
    expect(positionAt(pts, at("2025-08-12T15:30:00Z"))).toMatchObject({ lat: 40.7794, lng: -73.9632 });

    const visit = { placeVisit: { location: { latitudeE7: 407794000, longitudeE7: -739632000 }, duration: { startTimestamp: "2025-08-12T14:00:00Z", endTimestamp: "2025-08-12T17:00:00Z" } } };
    const sem = fillStays(timelineObjectToPoints(visit, window), timelineObjectToStays(visit), window);
    expect(positionAt(sem, at("2025-08-12T15:30:00Z"))).toMatchObject({ lat: 40.7794, lng: -73.9632 });

    const { points, recorded } = await parseGoogleExport(fx("google-timeline-android.json"), window);
    expect(recorded).toBe(5);
    expect(positionAt(points, at("2025-08-12T14:40:00Z"))).toMatchObject({ lat: 44.353, lng: -68.203 });
  });

  it("leave a recorded path that covers the visit's hours exactly as it was", () => {
    // A walk around the museum's grounds, recorded every 2 minutes, during the same hours as the visit.
    const path = Array.from({ length: 91 }, (_, i) => ({ time: new Date(at("2025-08-12T14:00:00Z") + i * 120_000).toISOString(), point: `geo:${(40.775 + (i % 10) * 0.001).toFixed(4)},-73.96` }));
    const walk: Seg = { startTime: "2025-08-12T14:00:00Z", endTime: "2025-08-12T17:00:00Z", timelinePath: path };
    const alone = parse([walk]);
    const both = parse([walk, museum("2025-08-12T14:00:00Z", "2025-08-12T17:00:00Z")]);
    expect(both).toEqual(alone);
    expect(computeStats(both).distanceM).toBe(computeStats(alone).distanceM);
    expect(positionAt(both, at("2025-08-12T14:03:00Z"))!.lat).toBeCloseTo(40.7765, 4);
  });

  it("fill only the hours between recorded stretches, not within a step of them", () => {
    const walk = (from: string, to: string): Seg => ({ startTime: from, endTime: to, timelinePath: [{ point: "geo:40.77,-73.96", time: from }, { point: "geo:40.771,-73.96", time: to }] });
    const pts = parse([walk("2025-08-12T13:50:00Z", "2025-08-12T14:00:00Z"), museum("2025-08-12T14:00:00Z", "2025-08-12T17:00:00Z"), walk("2025-08-12T15:00:00Z", "2025-08-12T15:08:00Z")]);
    const recorded = pts.filter((p) => !p.stay).map((p) => p.t);
    for (const p of pts.filter((q) => q.stay)) for (const r of recorded) expect(Math.abs(p.t - r)).toBeGreaterThanOrEqual(STAY_STEP_MS);
    // Between 14:00 and 15:00 the visit fills in, from the nearer recorded end: the walk arrived at 14:00 and the next
    // one set off at 15:00, both inside the visit. The 8-minute walk in the middle is left alone.
    expect(positionAt(pts, at("2025-08-12T14:20:00Z"))).toMatchObject({ lat: 40.771 });
    expect(positionAt(pts, at("2025-08-12T14:40:00Z"))).toMatchObject({ lat: 40.77 });
    expect(pts.filter((p) => p.stay && p.t > at("2025-08-12T15:00:00Z") && p.t < at("2025-08-12T15:08:00Z"))).toEqual([]);
    expect(positionAt(pts, at("2025-08-12T16:30:00Z"))).toMatchObject({ lat: 40.7794 });
  });

  it("fill a sparse path inside a visit from its own points, not by zig-zagging to the centre", () => {
    // A point every 15 minutes, 300 m from the visit's centre.
    const path = Array.from({ length: 13 }, (_, i) => ({ time: new Date(at("2025-08-12T14:00:00Z") + i * 15 * 60_000).toISOString(), point: "geo:40.7821,-73.9632" }));
    const pts = parse([{ startTime: "2025-08-12T14:00:00Z", endTime: "2025-08-12T17:00:00Z", timelinePath: path }, museum("2025-08-12T14:00:00Z", "2025-08-12T17:00:00Z")]);
    expect(pts.some((p) => p.stay)).toBe(true);
    expect(pts.every((p) => p.lat === 40.7821)).toBe(true);
    expect(computeStats(pts).distanceM).toBe(0);
  });

  it("put a point at local midnight inside a stay, where the trace is split into days", () => {
    const midnight = at("2025-08-13T04:00:00Z");
    const hotel: Seg = { startTime: "2025-08-12T23:52:00Z", endTime: "2025-08-13T11:00:00Z", visit: { topCandidate: { placeLocation: "geo:44.35,-68.2" } } };
    const pts = fillStays([], [segmentToStay(hotel)!], window, [midnight]);
    expect(pts.map((p) => p.t)).toContain(midnight);
  });

  it("let a visit inside another visit fill its own hours, and the outer one the rest", () => {
    const mall = { startTime: "2025-08-12T14:00:00Z", endTime: "2025-08-12T17:00:00Z", visit: { hierarchyLevel: 0, topCandidate: { placeLocation: "geo:40.70,-74.00" } } };
    const shop = { startTime: "2025-08-12T15:00:00Z", endTime: "2025-08-12T16:00:00Z", visit: { hierarchyLevel: "1", topCandidate: { placeLocation: "geo:40.71,-74.01" } } };
    const pts = parse([mall, shop]);
    expect(pts.map((p) => p.t)).toEqual([...new Set(pts.map((p) => p.t))].sort((a, b) => a - b));
    expect(pts.filter((p) => p.t >= at("2025-08-12T15:00:00Z") && p.t <= at("2025-08-12T16:00:00Z")).every((p) => p.lat === 40.71)).toBe(true);
    expect(positionAt(pts, at("2025-08-12T14:30:00Z"))).toMatchObject({ lat: 40.7 });
    expect(positionAt(pts, at("2025-08-12T15:30:00Z"))).toMatchObject({ lat: 40.71 });

    const nested = { placeVisit: { location: { latE7: 407000000, lngE7: -740000000 }, duration: { startTimestamp: "2025-08-12T14:00:00Z", endTimestamp: "2025-08-12T17:00:00Z" }, childVisits: [{ location: { latE7: 407100000, lngE7: -740100000 }, duration: { startTimestamp: "2025-08-12T15:00:00Z", endTimestamp: "2025-08-12T16:00:00Z" } }] } };
    const sem = fillStays([], timelineObjectToStays(nested), window);
    expect(positionAt(sem, at("2025-08-12T15:30:00Z"))).toMatchObject({ lat: 40.71 });
    expect(positionAt(sem, at("2025-08-12T16:30:00Z"))).toMatchObject({ lat: 40.7 });
  });

  it("keep only the two ends of a visit Google doubts", () => {
    const pts = parse([museum("2025-08-12T14:00:00Z", "2025-08-12T17:00:00Z", { probability: 0.2 })]);
    expect(pts.map((p) => p.t)).toEqual([at("2025-08-12T14:00:00Z"), at("2025-08-12T17:00:00Z")]);
    expect(positionAt(pts, at("2025-08-12T15:30:00Z"))).toBeNull();
    // Semantic visitConfidence is a percentage: 1 means 1%, not certainty.
    const barely = { placeVisit: { location: { latE7: 407000000, lngE7: -740000000 }, visitConfidence: 1, duration: { startTimestamp: "2025-08-12T14:00:00Z", endTimestamp: "2025-08-12T17:00:00Z" } } };
    expect(fillStays([], timelineObjectToStays(barely), window)).toHaveLength(2);
    const doubted = { placeVisit: { location: { latE7: 407000000, lngE7: -740000000 }, visitConfidence: 30, duration: { startTimestamp: "2025-08-12T14:00:00Z", endTimestamp: "2025-08-12T17:00:00Z" } } };
    expect(fillStays([], timelineObjectToStays(doubted), window)).toHaveLength(2);
  });

  it("fill only the part of a stay inside the trip window", () => {
    const w = { startMs: at("2025-08-12T00:00:00Z"), endMs: at("2025-08-12T23:59:59Z") };
    // A hotel stay from the evening before: the trip's part of it starts at the window's start.
    const pts = parse([{ startTime: "2025-08-11T20:00:00Z", endTime: "2025-08-12T08:00:00Z", visit: { topCandidate: { placeLocation: "44.35°, -68.2°" } } }], w);
    expect(pts[0].t).toBe(w.startMs);
    expect(pts.at(-1)!.t).toBe(at("2025-08-12T08:00:00Z"));
    expect(pts.every((p) => p.t >= w.startMs && p.t <= w.endMs)).toBe(true);
    expect(parse([{ startTime: "2025-08-01T20:00:00Z", endTime: "2025-08-02T08:00:00Z", visit: { topCandidate: { placeLocation: "44.35°, -68.2°" } } }], w)).toEqual([]);
  });
});
