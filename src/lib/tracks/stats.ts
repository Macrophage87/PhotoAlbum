import { haversine } from "@/lib/geo/haversine";
import type { DeviceSession, TrackPoint, TrackStatsResult } from "./types";

export const MOVING_SPEED_MS = 0.5;
export const MAX_GAP_S = 30;
export const TELEPORT_SPEED_MS = 50;
/** A run of fast segments must be longer than this to be travel rather than a glitch. */
const MIN_TRAVEL_SEGMENTS = 5;
/** A fast run this long is travel even if it ends near where it began (a sightseeing flight's loop). */
const LONG_RUN_SEGMENTS = 30;
/** A segment's moving-time gap limit looks at the intervals within this many segments either side. */
const GAP_WINDOW = 15;
export const ELEVATION_THRESHOLD_M = 3;

function median3(a: number, b: number, c: number) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function movingAverage(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

/** Smoothed elevation gain/loss with hysteresis so metre-level GPS jitter doesn't accumulate. */
export function elevationGainLoss(ele: number[], window = 5, threshold = ELEVATION_THRESHOLD_M): { gain: number; loss: number } {
  if (ele.length < 2) return { gain: 0, loss: 0 };
  const sm = movingAverage(ele, window);
  let gain = 0, loss = 0, ref = sm[0];
  for (let i = 1; i < sm.length; i++) {
    const e = sm[i];
    if (e - ref >= threshold) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= threshold) {
      loss += ref - e;
      ref = e;
    }
  }
  return { gain, loss };
}

/** 30 s rolling-average power, raised to the 4th, averaged, 4th-rooted. */
export function normalizedPower(points: TrackPoint[]): number | null {
  const withPower = points.filter((p) => p.pwr !== undefined);
  if (withPower.length < 30) return null;
  let sum4 = 0, n = 0;
  let windowStart = 0;
  let windowSum = 0;
  const q: number[] = [];
  for (let i = 0; i < withPower.length; i++) {
    q.push(withPower[i].pwr!);
    windowSum += withPower[i].pwr!;
    while (withPower[i].t - withPower[windowStart].t > 30_000) {
      windowSum -= q.shift()!;
      windowStart++;
    }
    const avg = windowSum / q.length;
    sum4 += avg ** 4;
    n++;
  }
  return n ? Math.round(Math.pow(sum4 / n, 0.25)) : null;
}

/**
 * Which segments (points[i - 1] to points[i], flagged at i) are GPS jumps rather than travel. A segment faster than
 * TELEPORT_SPEED_MS is travel only as part of a sustained run of fast segments that gets somewhere: a train or a
 * plane keeps going sample after sample, while a glitch is a lone leap, a spike, or a few fast steps out that pause
 * and come back. A fixed speed limit alone would throw away every segment of a flight or a high-speed train.
 */
function teleportSegments(points: TrackPoint[], dist: number[]): boolean[] {
  const n = points.length;
  const fast = (i: number) => {
    const dt = (points[i].t - points[i - 1].t) / 1000;
    return dt > 0 && dist[i] / dt > TELEPORT_SPEED_MS;
  };
  const out = new Array<boolean>(n).fill(false);
  for (let s = 1; s < n; s++) {
    if (!fast(s)) continue;
    let e = s, path = dist[s];
    while (e + 1 < n && fast(e + 1)) path += dist[++e];
    const net = haversine(points[s - 1].lat, points[s - 1].lng, points[e].lat, points[e].lng);
    const travel = e - s + 1 > MIN_TRAVEL_SEGMENTS && (net >= path / 2 || e - s + 1 >= LONG_RUN_SEGMENTS);
    if (!travel) out.fill(true, s, e + 1);
    s = e;
  }
  return out;
}

/**
 * The longest step between samples still counted as moving, for each segment. Phones on battery saver and satellite
 * trackers log once a minute or less often, so the limit grows with the usual interval around that segment: a watch
 * that switches to sparse logging halfway through gets each part judged by its own rate. "Usual" is the median by
 * time of the neighbouring intervals, leaving out the segment's own, so one long gap cannot vouch for itself.
 */
function gapLimits(points: TrackPoint[]): number[] {
  const n = points.length;
  const dt = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) dt[i] = (points[i].t - points[i - 1].t) / 1000;
  const out = new Array<number>(n).fill(MAX_GAP_S);
  const around: number[] = [];
  for (let i = 1; i < n; i++) {
    around.length = 0;
    let total = 0;
    for (let j = Math.max(1, i - GAP_WINDOW); j <= Math.min(n - 1, i + GAP_WINDOW); j++) {
      if (j !== i && dt[j] > 0) {
        around.push(dt[j]);
        total += dt[j];
      }
    }
    if (!around.length) continue;
    around.sort((x, y) => x - y);
    let acc = 0, k = 0;
    while (k < around.length - 1 && (acc += around[k]) < total / 2) k++;
    out[i] = Math.max(MAX_GAP_S, 3 * around[k]);
  }
  return out;
}

export type StatsOptions = { skipElevation?: boolean; elevationWindow?: number; cyclingCadence?: boolean };

export function computeStats(points: TrackPoint[], opts: StatsOptions = {}): TrackStatsResult {
  const n = points.length;
  const empty: TrackStatsResult = {
    distanceM: 0, movingTimeS: 0, elapsedTimeS: 0, elevGainM: null, elevLossM: null, minEleM: null, maxEleM: null,
    avgSpeedMs: null, maxSpeedMs: null, avgHr: null, maxHr: null, avgCadence: null, maxCadence: null, avgPower: null, maxPower: null, normalizedPower: null, calories: null,
  };
  if (n < 2) return empty;

  let distance = 0, moving = 0;
  const speeds: number[] = [];
  // time-weighted sensor sums
  let hrSum = 0, hrT = 0, hrMax = 0;
  let cadSum = 0, cadT = 0, cadMax = 0;
  let pwrSum = 0, pwrT = 0, pwrMax = 0;

  const dist = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) dist[i] = haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  const teleports = teleportSegments(points, dist);
  const maxGaps = gapLimits(points);
  let movingDistance = 0;

  for (let i = 1; i < n; i++) {
    const a = points[i - 1], b = points[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const dd = dist[i];
    const v = b.spd !== undefined ? b.spd : dd / dt;
    const teleport = teleports[i];
    if (!teleport) distance += dd;
    speeds.push(teleport ? 0 : v);
    const maxGap = maxGaps[i];
    if (v >= MOVING_SPEED_MS && dt <= maxGap && !teleport) {
      moving += dt;
      movingDistance += dd;
    }
    // Sensor samples are time-weighted, but a sample after a long pause only counts once.
    const w = dt <= maxGap ? dt : 1;
    if (b.hr !== undefined && b.hr > 0) { hrSum += b.hr * w; hrT += w; if (b.hr > hrMax) hrMax = b.hr; }
    if (b.cad !== undefined && (b.cad > 0 || !opts.cyclingCadence)) { cadSum += b.cad * w; cadT += w; if (b.cad > cadMax) cadMax = b.cad; }
    if (b.pwr !== undefined) { pwrSum += b.pwr * w; pwrT += w; if (b.pwr > pwrMax) pwrMax = b.pwr; }
  }
  const elapsed = (points[n - 1].t - points[0].t) / 1000;

  // max speed after a 3-point median filter to drop single-sample spikes
  let maxSpeed = 0;
  for (let i = 0; i < speeds.length; i++) {
    const m = median3(speeds[Math.max(0, i - 1)], speeds[i], speeds[Math.min(speeds.length - 1, i + 1)]);
    if (m > maxSpeed) maxSpeed = m;
  }

  let elevGain: number | null = null, elevLoss: number | null = null, minEle: number | null = null, maxEle: number | null = null;
  const eles = points.map((p) => p.ele).filter((e): e is number => e !== undefined);
  if (!opts.skipElevation && eles.length >= Math.max(2, n * 0.2)) {
    const { gain, loss } = elevationGainLoss(eles, opts.elevationWindow ?? 5);
    elevGain = Math.round(gain);
    elevLoss = Math.round(loss);
    // Loop rather than spread: Math.min(...arr) overflows the call stack past ~100k points.
    let lo = Infinity, hi = -Infinity;
    for (const e of eles) {
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    minEle = lo;
    maxEle = hi;
  }

  return {
    distanceM: Math.round(distance),
    movingTimeS: Math.round(moving),
    elapsedTimeS: Math.round(elapsed),
    elevGainM: elevGain,
    elevLossM: elevLoss,
    minEleM: minEle,
    maxEleM: maxEle,
    // Over the moving stretches only: distance covered across a gap is real but its time is not moving time.
    avgSpeedMs: moving > 0 ? movingDistance / moving : null,
    maxSpeedMs: maxSpeed > 0 ? maxSpeed : null,
    avgHr: hrT > 0 ? Math.round(hrSum / hrT) : null,
    maxHr: hrMax > 0 ? hrMax : null,
    avgCadence: cadT > 0 ? Math.round(cadSum / cadT) : null,
    maxCadence: cadMax > 0 ? cadMax : null,
    avgPower: pwrT > 0 ? Math.round(pwrSum / pwrT) : null,
    maxPower: pwrMax > 0 ? pwrMax : null,
    normalizedPower: normalizedPower(points),
    calories: null,
  };
}

/** Device-reported numbers win; ours fill the gaps. */
export function mergeStats(computed: TrackStatsResult, device?: DeviceSession): TrackStatsResult {
  if (!device) return computed;
  const pick = <T>(d: T | undefined, c: T): T => (d !== undefined && d !== null && !(typeof d === "number" && !Number.isFinite(d)) ? d : c);
  const r = (v: number | null | undefined) => (v === undefined || v === null ? null : Math.round(v));
  return {
    distanceM: Math.round(pick(device.distanceM, computed.distanceM)),
    movingTimeS: Math.round(pick(device.movingTimeS, computed.movingTimeS)),
    elapsedTimeS: Math.round(pick(device.elapsedTimeS, computed.elapsedTimeS)),
    elevGainM: pick(device.elevGainM, computed.elevGainM),
    elevLossM: pick(device.elevLossM, computed.elevLossM),
    minEleM: computed.minEleM,
    maxEleM: computed.maxEleM,
    avgSpeedMs: pick(device.avgSpeedMs, computed.avgSpeedMs),
    maxSpeedMs: pick(device.maxSpeedMs, computed.maxSpeedMs),
    avgHr: r(pick(device.avgHr, computed.avgHr)),
    maxHr: r(pick(device.maxHr, computed.maxHr)),
    avgCadence: r(pick(device.avgCadence, computed.avgCadence)),
    maxCadence: r(pick(device.maxCadence, computed.maxCadence)),
    avgPower: r(pick(device.avgPower, computed.avgPower)),
    maxPower: r(pick(device.maxPower, computed.maxPower)),
    normalizedPower: r(pick(device.normalizedPower, computed.normalizedPower)),
    calories: r(pick(device.calories, computed.calories)),
  };
}
