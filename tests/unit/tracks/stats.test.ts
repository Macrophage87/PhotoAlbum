import { describe, expect, it } from "vitest";
import { computeStats, elevationGainLoss, mergeStats } from "@/lib/tracks/stats";
import type { TrackPoint } from "@/lib/tracks/types";

/** 1 km due north at 2 m/s (1 point/s), with a 2-minute stop in the middle. */
function syntheticWalk(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  const t0 = Date.parse("2025-08-12T13:00:00Z");
  const mPerDegLat = 111_195;
  let t = t0, lat = 44.0;
  for (let i = 0; i <= 250; i++) {
    pts.push({ t, lat, lng: -68 });
    t += 1000;
    lat += 2 / mPerDegLat;
  }
  t += 120_000; // stand still 2 min
  for (let i = 0; i < 250; i++) {
    pts.push({ t, lat, lng: -68 });
    t += 1000;
    lat += 2 / mPerDegLat;
  }
  return pts;
}

describe("computeStats", () => {
  it("measures distance, moving vs elapsed time and speed", () => {
    const s = computeStats(syntheticWalk());
    expect(s.distanceM).toBeGreaterThanOrEqual(998);
    expect(s.distanceM).toBeLessThanOrEqual(1002);
    // 250 + 249 one-second moving segments; the 121 s pause is not moving time
    expect(s.movingTimeS).toBe(499);
    expect(s.elapsedTimeS).toBe(620);
    expect(s.avgSpeedMs).toBeCloseTo(2, 1);
    expect(s.maxSpeedMs).toBeCloseTo(2, 1);
    expect(s.elevGainM).toBeNull();
  });
  it("ignores teleport glitches and single-sample speed spikes", () => {
    const pts = syntheticWalk();
    pts[100] = { ...pts[100], lat: 45 }; // 100 km jump for one sample
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(1100);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("computes time-weighted HR/cadence/power with maxima", () => {
    const pts = syntheticWalk().map((p, i) => ({ ...p, hr: 120 + (i % 2) * 20, cad: 80, pwr: 200 }));
    const s = computeStats(pts);
    expect(s.avgHr).toBe(130);
    expect(s.maxHr).toBe(140);
    expect(s.avgCadence).toBe(80);
    expect(s.avgPower).toBe(200);
    expect(s.normalizedPower).toBe(200);
  });
  it("elevation gain ignores meter-level noise but keeps real climbs", () => {
    const ele: number[] = [];
    for (let i = 0; i < 300; i++) ele.push(100 + (i < 150 ? i : 300 - i) * 0.5 + ((i * 7) % 3) - 1);
    const { gain, loss } = elevationGainLoss(ele);
    expect(gain).toBeGreaterThan(65);
    expect(gain).toBeLessThan(85);
    expect(loss).toBeGreaterThan(65);
    expect(loss).toBeLessThan(85);
    const flat = new Array(200).fill(0).map((_, i) => 50 + (i % 2));
    expect(elevationGainLoss(flat).gain).toBe(0);
  });
  it("prefers device session values when merging", () => {
    const computed = computeStats(syntheticWalk());
    const merged = mergeStats(computed, { distanceM: 1234, avgHr: 140, calories: 300 });
    expect(merged.distanceM).toBe(1234);
    expect(merged.avgHr).toBe(140);
    expect(merged.calories).toBe(300);
    expect(merged.movingTimeS).toBe(computed.movingTimeS);
  });
});

describe("computeStats on very large tracks", () => {
  it("handles 300k points with elevation without overflowing the stack", () => {
    const t0 = Date.parse("2025-08-12T13:00:00Z");
    const pts: TrackPoint[] = Array.from({ length: 300_000 }, (_, i) => ({ t: t0 + i * 1000, lat: 44 + i * 1e-5, lng: -68, ele: 100 + Math.sin(i / 500) * 50 }));
    const s = computeStats(pts);
    expect(s.minEleM).toBeCloseTo(50, 0);
    expect(s.maxEleM).toBeCloseTo(150, 0);
    expect(s.distanceM).toBeGreaterThan(300_000);
  });
});

/** Due north at `speed` m/s, one point every `stepS` seconds. */
function line(count: number, speed: number, stepS: number, t0 = Date.parse("2025-08-12T13:00:00Z"), lat0 = 44): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: t0 + i * stepS * 1000, lat: lat0 + (i * stepS * speed) / 111_195, lng: -68 }));
}

describe("computeStats on fast transport", () => {
  it("keeps the distance and speed of a high-speed train", () => {
    const s = computeStats(line(601, 80, 1));
    expect(s.distanceM).toBeGreaterThan(47_500);
    expect(s.distanceM).toBeLessThan(48_500);
    expect(s.movingTimeS).toBe(600);
    expect(s.avgSpeedMs).toBeCloseTo(80, 0);
    expect(s.maxSpeedMs).toBeCloseTo(80, 0);
  });
  it("keeps a flight logged once a minute", () => {
    const s = computeStats(line(61, 250, 60));
    expect(s.distanceM).toBeGreaterThan(890_000);
    expect(s.avgSpeedMs).toBeCloseTo(250, 0);
  });
  it("still drops a glitch that wanders off for a few samples and comes back", () => {
    const pts = syntheticWalk();
    pts[100] = { ...pts[100], lat: pts[100].lat + 0.01 };
    pts[101] = { ...pts[101], lat: pts[101].lat + 0.02 };
    pts[102] = { ...pts[102], lat: pts[102].lat + 0.01 };
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(1100);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("still drops a one-sample spike on a motorway drive", () => {
    const pts = line(301, 30, 1);
    pts[150] = { ...pts[150], lng: -67.99 };
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(9100);
    expect(s.maxSpeedMs).toBeLessThan(35);
  });
});

describe("computeStats on sparsely sampled tracks", () => {
  it("counts moving time for a ride logged once a minute, but not a long stop", () => {
    const ride = line(101, 6, 60);
    const t1 = ride[100].t + 20 * 60_000; // a 20-minute stop, then another 20 minutes of riding
    const pts = [...ride, ...line(21, 6, 60, t1, ride[100].lat).slice(1)];
    const s = computeStats(pts);
    // 100 minutes, then 19 more: the step that spans the stop is not moving.
    expect(s.movingTimeS).toBe(119 * 60);
    expect(s.avgSpeedMs).toBeGreaterThan(5.9);
    expect(s.avgSpeedMs).toBeLessThan(6.1);
  });
  it("counts a satellite tracker reporting every ten minutes", () => {
    const s = computeStats(line(13, 1.2, 600));
    expect(s.movingTimeS).toBe(7200);
    expect(s.avgSpeedMs).toBeCloseTo(1.2, 1);
  });
});

describe("computeStats keeps dropping GPS glitches", () => {
  const M_LNG = 1 / (111_195 * Math.cos((44 * Math.PI) / 180)); // degrees of longitude per metre at 44°N
  const east = (p: TrackPoint, m: number): TrackPoint => ({ ...p, lng: p.lng + m * M_LNG });
  const offset = (p: TrackPoint, e: number, n: number): TrackPoint => ({ ...p, lng: p.lng + e * M_LNG, lat: p.lat + n / 111_195 });
  const walkWith = (offsets: number[], at = 100) => {
    const pts = syntheticWalk();
    offsets.forEach((m, k) => (pts[at + k] = east(pts[at + k], m)));
    return computeStats(pts);
  };
  const clean = computeStats(syntheticWalk());

  it("a glitch that pauses out there before coming back", () => {
    const s = walkWith([100, 200, 200, 100]);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("three steps out and three back", () => {
    const s = walkWith([100, 200, 300, 200, 100]);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a gradual excursion out and back", () => {
    const s = walkWith([...Array.from({ length: 10 }, (_, k) => 60 * (k + 1)), ...Array.from({ length: 9 }, (_, k) => 60 * (9 - k))]);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("eight points scattered 300 m around a walk logged every 5 s", () => {
    const pts = line(121, 2, 5);
    const around = [[300, 0], [0, 300], [-300, 0], [0, -300], [300, 0], [0, 300], [-300, 0], [0, -300]];
    around.forEach(([e, n], k) => (pts[50 + k] = offset(pts[50 + k], e, n)));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(1_300);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a one-way leap in the middle of a walk", () => {
    const pts = syntheticWalk().map((p, i) => (i >= 250 ? east(p, 2_000) : p));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(1_100);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
});

describe("computeStats on mixed and gappy sampling", () => {
  it("judges each part of a track by its own logging rate", () => {
    const fine = line(3601, 6, 1);
    const sparse = line(181, 6, 60, fine[3600].t, fine[3600].lat).slice(1);
    const s = computeStats([...fine, ...sparse]);
    expect(s.movingTimeS).toBe(4 * 3600);
    expect(s.avgSpeedMs).toBeCloseTo(6, 1);
  });
  it("time-weights sensor samples by each part's own logging rate", () => {
    const fine = line(601, 2, 1).map((p) => ({ ...p, hr: 100 }));
    const sparse = line(31, 2, 60, fine[600].t, fine[600].lat).slice(1).map((p) => ({ ...p, hr: 150 }));
    // 600 s at 100 bpm and 1800 s at 150 bpm
    expect(computeStats([...fine, ...sparse]).avgHr).toBe(138);
  });
  it("never reports an average speed above the maximum", () => {
    const before = line(31, 250, 60);
    // Twenty minutes without a fix mid-flight: the distance is real, but it is not moving time.
    const after = line(31, 250, 60, before[30].t + 20 * 60_000, before[30].lat + (20 * 60 * 250) / 111_195).slice(1);
    const s = computeStats([...before, ...after]);
    expect(s.avgSpeedMs!).toBeLessThanOrEqual(s.maxSpeedMs! + 1e-9);
    expect(s.avgSpeedMs).toBeCloseTo(250, 0);
  });
});
