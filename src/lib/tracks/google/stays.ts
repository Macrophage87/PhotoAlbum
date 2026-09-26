import { MAX_INTERPOLATION_GAP_MS } from "../interpolate";
import type { TrackPoint } from "../types";
import type { Window } from "./common";

/** Spacing of the points a stay is filled with: close enough that positionAt interpolates between them. */
export const STAY_STEP_MS = MAX_INTERPOLATION_GAP_MS / 2;
/** Below this, Google itself doubts the person stopped at all, so only the visit's two ends are kept. */
export const MIN_VISIT_PROBABILITY = 0.5;

/**
 * A visit: Google's claim that the person stayed at one spot from start to end. `level` is its place in Google's
 * hierarchy of visits (a shop inside a shopping centre is deeper than the centre); `fill` is false for a visit
 * Google was not confident of.
 */
export type Stay = { start: number; end: number | null; lat: number; lng: number; level: number; fill: boolean };

export type GoogleParse = { points: TrackPoint[]; stays: Stay[] };

/** A probability Google may write as a number or a string, and on either a 0-1 or a 0-100 scale; null when absent. */
export function probability(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Add points for the stretches of visits that nothing recorded covers, so a photo taken in the middle of a
 * three-hour museum visit is placed at the museum rather than falling into a gap too long to interpolate across.
 *
 * Recorded points (raw paths, activity ends) always win: filler only goes into gaps between them longer than
 * positionAt will interpolate across, and not within one step of a recorded point, so a path that already covers the
 * visit is left exactly as it was rather than zig-zagging to the visit's centre and back. Where visits overlap, the
 * deepest one fills its own hours and its parent the rest.
 */
export function fillStays(points: TrackPoint[], stays: Stay[], window: Window): TrackPoint[] {
  const real = [...points].sort((a, b) => a.t - b.t);
  const times = real.map((p) => p.t);
  // First index with a time at or after t.
  const after = (t: number) => {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const uncovered = (t: number) => {
    const i = after(t);
    const prev = i > 0 ? times[i - 1] : undefined, next = i < times.length ? times[i] : undefined;
    if (prev !== undefined && next !== undefined && next - prev <= MAX_INTERPOLATION_GAP_MS) return false;
    return (prev === undefined || t - prev >= STAY_STEP_MS) && (next === undefined || next - t >= STAY_STEP_MS);
  };

  const claimed: [number, number][] = [];
  const filler: TrackPoint[] = [];
  for (const s of [...stays].sort((a, b) => b.level - a.level || a.start - b.start)) {
    const candidates: number[] = [];
    if (s.fill && s.end !== null && s.end > s.start) {
      const from = Math.max(s.start, window.startMs), to = Math.min(s.end, window.endMs);
      if (from > to) continue;
      for (let t = from; t < to; t += STAY_STEP_MS) candidates.push(t);
      candidates.push(to);
    } else {
      candidates.push(s.start);
      if (s.end !== null && s.end !== s.start) candidates.push(s.end);
    }
    for (const t of candidates) {
      if (t < window.startMs || t > window.endMs || !uncovered(t)) continue;
      if (claimed.some(([a, b]) => t >= a && t <= b)) continue;
      filler.push({ t, lat: s.lat, lng: s.lng, stay: true });
    }
    if (s.fill && s.end !== null) claimed.push([s.start, s.end]);
  }
  return [...real, ...filler].sort((a, b) => a.t - b.t);
}
