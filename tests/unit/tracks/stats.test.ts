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
  it("a receiver's first fixes converging from kilometres away", () => {
    const pts = syntheticWalk();
    [3000, 2600, 2200, 1800, 1400, 1000, 600].forEach((m, k) => (pts[k] = east(pts[k], m)));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("an excursion that pauses at its far end for a sample", () => {
    const s = walkWith([100, 200, 300, 400, 500, 600, 600, 500, 400, 300, 200, 100]);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a 16-point ramp out and back with a pause in it", () => {
    const s = walkWith([60, 120, 180, 240, 300, 360, 420, 420, 420, 360, 300, 240, 180, 120, 60, 0]);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 20);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a burst of erratic fast fixes", () => {
    // Fast steps zig-zagging back and forth: no steady heading, so not travel however far they drift.
    const s = walkWith([200, -100, 300, 0, 400, 400, 400, 400]);
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
  it("does not count a drive's paused stretches as moving, even when two pauses are close together", () => {
    // Driving at 20 m/s, logged every second, with recording paused twice for 10 minutes while the car kept going.
    const pts: TrackPoint[] = [];
    let t = Date.parse("2025-08-12T13:00:00Z"), lat = 44;
    const step = (dt: number) => {
      t += dt * 1000;
      lat += (dt * 20) / 111_195;
      pts.push({ t, lat, lng: -68 });
    };
    pts.push({ t, lat, lng: -68 });
    for (let i = 0; i < 300; i++) step(1);
    step(600);
    for (let i = 0; i < 5; i++) step(1);
    step(600);
    for (let i = 0; i < 300; i++) step(1);
    expect(computeStats(pts).movingTimeS).toBe(605);
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

describe("computeStats keeps real flights and trains whose speed varies", () => {
  it("a flight that climbs and descends around its cruise, logged every 10 s", () => {
    const speeds = [...Array.from({ length: 20 }, (_, i) => 70 + i * 8), ...new Array(100).fill(230), ...Array.from({ length: 20 }, (_, i) => 230 - i * 8)];
    const pts: TrackPoint[] = [{ t: Date.parse("2025-08-12T13:00:00Z"), lat: 44, lng: -68 }];
    for (const v of speeds) {
      const p = pts[pts.length - 1];
      pts.push({ t: p.t + 10_000, lat: p.lat + (v * 10) / 111_195, lng: -68 });
    }
    const expected = speeds.reduce((a, v) => a + v * 10, 0);
    const s = computeStats(pts);
    expect(s.distanceM).toBeGreaterThan(expected * 0.99);
    expect(s.maxSpeedMs).toBeCloseTo(230, 0);
  });
  it("a 1 Hz train with one stale fix", () => {
    const pts = line(601, 80, 1);
    pts[300] = { ...pts[300], lat: pts[299].lat };
    expect(computeStats(pts).distanceM).toBeGreaterThan(47_500);
  });
  it("a 1 Hz train with a duplicated timestamp", () => {
    const pts = line(601, 80, 1);
    pts.splice(300, 0, { ...pts[299] });
    expect(computeStats(pts).distanceM).toBeGreaterThan(47_500);
  });
  it("a train logged every 30 s with two slow samples", () => {
    const pts = line(61, 80, 30);
    for (const i of [20, 21]) pts[i] = { ...pts[i], lat: pts[19].lat + (i - 19) * 10 / 111_195 };
    expect(computeStats(pts).distanceM).toBeGreaterThan(130_000);
  });
});

describe("computeStats drops a glitch that leaps off a walk and holds there", () => {
  const M_LNG = 1 / (111_195 * Math.cos((44 * Math.PI) / 180));
  const clean = computeStats(syntheticWalk());
  it("and comes back", () => {
    const pts = syntheticWalk();
    [100, 200, 300, 400, 500, 600, 600, 600, 600, 500, 400, 300, 200, 100].forEach((m, k) => (pts[100 + k] = { ...pts[100 + k], lng: pts[100 + k].lng + m * M_LNG }));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 30);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("and never comes back", () => {
    const pts = syntheticWalk().map((p, i) => (i >= 100 ? { ...p, lng: p.lng + Math.min(600, (i - 99) * 100) * M_LNG } : p));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean.distanceM + 30);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
});

describe("computeStats drops long bursts of bad GPS", () => {
  const M_LNG = 1 / (111_195 * Math.cos((44 * Math.PI) / 180));
  const shift = (p: TrackPoint, e: number, n = 0): TrackPoint => ({ ...p, lng: p.lng + e * M_LNG, lat: p.lat + n / 111_195 });
  // Deterministic stand-in for Math.random.
  const rng = (seed: number) => () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);

  it("twenty 200 m spikes in a row on a run", () => {
    const pts = line(1901, 3, 1);
    const clean = computeStats(pts).distanceM;
    for (let k = 0; k < 20; k++) pts[1000 + 3 * k] = shift(pts[1000 + 3 * k], 200);
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 100);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("two minutes of fixes scattered up to 500 m around the path", () => {
    const pts = line(1901, 3, 1);
    const clean = computeStats(pts).distanceM;
    const r = rng(7);
    for (let i = 1000; i < 1120; i++) {
      const a = r() * 2 * Math.PI, d = 100 + r() * 400;
      pts[i] = shift(pts[i], d * Math.cos(a), d * Math.sin(a));
    }
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 300);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a phone flapping between its own fix and a Wi-Fi fix 1.5 km away", () => {
    const pts = line(1215, 1.4, 1);
    const clean = computeStats(pts).distanceM;
    for (let i = 500; i < 620; i += 2) pts[i] = shift(pts[i], 1_500);
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 100);
    expect(s.avgSpeedMs!).toBeLessThan(2);
  });
  it("a steady drift off a drive at four times its speed", () => {
    const pts = line(601, 25, 1);
    const clean = computeStats(pts).distanceM;
    // Eight fixes marching sideways at 110 m/s, then easing back onto the road over 40 s.
    for (let k = 0; k < 8; k++) pts[300 + k] = shift(pts[300 + k], 110 * (k + 1));
    for (let k = 1; k < 40; k++) pts[307 + k] = shift(pts[307 + k], 880 * (1 - k / 40));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 1_000);
    // The easing back is slow enough to be believed; the 110 m/s march is not.
    expect(s.maxSpeedMs).toBeLessThan(40);
  });
  it("a marching drift off a walk logged every 30 s", () => {
    const pts = line(121, 1.3, 30);
    const clean = computeStats(pts).distanceM;
    // Eight fixes marching off at 60 m/s, and the walk carrying on from where they ended.
    for (let i = 60; i < pts.length; i++) pts[i] = shift(pts[i], 1_800 * Math.min(8, i - 59));
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 100);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
});

describe("computeStats counts reversals between fast segments only", () => {
  const M_LNG = 1 / (111_195 * Math.cos((44 * Math.PI) / 180));
  it("a phone flapping 300 m and holding each position for two fixes", () => {
    const pts = line(1901, 3, 1);
    const clean = computeStats(pts).distanceM;
    for (let i = 1000; i < 1120; i++) if ((i - 1000) % 4 < 2) pts[i] = { ...pts[i], lng: pts[i].lng + 300 * M_LNG };
    const s = computeStats(pts);
    expect(s.distanceM).toBeLessThan(clean + 300);
    expect(s.maxSpeedMs).toBeLessThan(5);
  });
  it("a train whose every fourth fix is a stale one re-reported with a few metres of jitter", () => {
    const pts = line(3601, 80, 1);
    for (let i = 4; i < pts.length; i += 4) {
      const a = (i * 2.4) % (2 * Math.PI);
      pts[i] = { ...pts[i - 1], t: pts[i].t, lat: pts[i - 1].lat + (3 * Math.sin(a)) / 111_195, lng: pts[i - 1].lng + 3 * Math.cos(a) * M_LNG };
    }
    expect(computeStats(pts).distanceM).toBeGreaterThan(280_000);
  });
});
