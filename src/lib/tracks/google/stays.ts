import { MAX_INTERPOLATION_GAP_MS } from "../interpolate";
import type { TrackPoint } from "../types";
import type { Window } from "./common";

/** Spacing of the points a stay is filled with: close enough that positionAt interpolates between them. */
export const STAY_STEP_MS = MAX_INTERPOLATION_GAP_MS / 2;
/** Below this, Google itself doubts the person stopped at all, so only the visit's two ends are kept. */
export const MIN_VISIT_PROBABILITY = 0.5;

/**
 * A visit: Google's claim that the person stayed at one spot from start to end. `fill` is false for a visit Google
 * was not confident of.
 */
export type Stay = { start: number; end: number | null; lat: number; lng: number; fill: boolean };

export type GoogleParse = { points: TrackPoint[]; stays: Stay[] };

/** A probability Google writes as a number or a string, on the given scale (1 or 100); null when absent. */
export function probability(v: unknown, scale: 1 | 100): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n / scale : null;
}

/**
 * Add points for the stretches of visits that nothing recorded covers, so a photo taken in the middle of a
 * three-hour museum visit is placed at the museum rather than falling into a gap too long to interpolate across.
 *
 * Recorded points (raw paths, activity ends) always win: filler only goes into gaps between them longer than
 * positionAt will interpolate across, and not within one step of a recorded point, so a path that already covers the
 * visit is left exactly as it was. Where a gap inside the visit has recorded points on both sides, the filler
 * stays at the nearer of them rather than zig-zagging to the visit's centre and back; the centre is used only for a
 * stretch of the visit with nothing recorded on one side. Where visits overlap, the shorter (more particular) one fills its own hours
 * and the longer one the rest.
 *
 * `cuts` are extra instants to fill at when a stay spans them: local midnights, so the stay reaches right up to where
 * the trace is split into days.
 */
export function fillStays(points: TrackPoint[], stays: Stay[], window: Window, cuts: number[] = []): TrackPoint[] {
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

  const claimed: [number, number][] = [];
  const filler: TrackPoint[] = [];
  const length = (s: Stay) => (s.end ?? s.start) - s.start;
  for (const s of [...stays].sort((a, b) => length(a) - length(b) || a.start - b.start)) {
    const candidates: number[] = [];
    const end = s.end ?? s.start;
    if (s.fill && end > s.start) {
      const from = Math.max(s.start, window.startMs), to = Math.min(end, window.endMs);
      if (from > to) continue;
      for (let t = from; t < to; t += STAY_STEP_MS) candidates.push(t);
      candidates.push(to);
      for (const c of cuts) if (c > from && c < to) candidates.push(c);
    } else {
      candidates.push(s.start);
      if (end !== s.start) candidates.push(end);
    }
    for (const t of candidates) {
      if (t < window.startMs || t > window.endMs) continue;
      if (claimed.some(([a, b]) => t >= a && t <= b)) continue;
      const i = after(t);
      const prev = i > 0 ? real[i - 1] : undefined, next = i < real.length ? real[i] : undefined;
      if (prev && next && next.t - prev.t <= MAX_INTERPOLATION_GAP_MS) continue;
      if ((prev && t - prev.t < STAY_STEP_MS) || (next && next.t - t < STAY_STEP_MS)) continue;
      // Recorded points on both sides within the visit say more about where in it the person was than its centre.
      const within = (p: TrackPoint | undefined): p is TrackPoint => !!p && p.t >= s.start && p.t <= end;
      const at = within(prev) && within(next) ? (t - prev.t <= next.t - t ? prev : next) : s;
      filler.push({ t, lat: at.lat, lng: at.lng, stay: true });
    }
    if (s.fill && end > s.start) claimed.push([s.start, end]);
  }
  return [...real, ...filler].sort((a, b) => a.t - b.t);
}
