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
  it("elevation gain ignores metre-level noise but keeps real climbs", () => {
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
