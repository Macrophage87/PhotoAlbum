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
    let from = s.start, to = end, cutsHere: number[] = [];
    if (s.fill && end > s.start) {
      from = Math.max(s.start, window.startMs);
      to = Math.min(end, window.endMs);
      if (from > to) continue;
      for (let t = from; t < to; t += STAY_STEP_MS) candidates.push(t);
      candidates.push(to);
      cutsHere = cuts.filter((c) => c > from && c < to);
    } else {
      candidates.push(s.start);
      if (end !== s.start) candidates.push(end);
    }
    const within = (p: TrackPoint | undefined): p is TrackPoint => !!p && p.t >= s.start && p.t <= end;
    // Strictly inside: a recorded point at the visit's very start or end is usually just where the journey to or from
    // it ended (Timeline.json puts activity ends there), which says nothing about where in the place the person was.
    const inside = (p: TrackPoint | undefined): p is TrackPoint => !!p && p.t > s.start && p.t < end;
    for (const t of candidates) {
      if (t < window.startMs || t > window.endMs) continue;
      if (claimed.some(([a, b]) => t >= a && t <= b)) continue;
      const i = after(t);
      const prev = i > 0 ? real[i - 1] : undefined, next = i < real.length ? real[i] : undefined;
      if ((prev && next && next.t - prev.t <= MAX_INTERPOLATION_GAP_MS) || next?.t === t) continue;
      // The visit's own start (or end) is kept when nothing recorded comes before (or after) it: otherwise the minutes
      // between it and the first recorded point would be covered by nothing.
      const openBefore = t === from && (!prev || t - prev.t > MAX_INTERPOLATION_GAP_MS);
      const openAfter = t === to && (!next || next.t - t > MAX_INTERPOLATION_GAP_MS);
      if (prev && t - prev.t < STAY_STEP_MS && !openAfter) continue;
      if (next && next.t - t < STAY_STEP_MS && !openBefore) continue;
      // Recorded points on both sides within the visit, one of them inside it, say more about where in it the person
      // was than its centre.
      const at = within(prev) && within(next) && (inside(prev) || inside(next)) ? (t - prev.t <= next.t - t ? prev : next) : s;
      filler.push({ t, lat: at.lat, lng: at.lng, filled: at === s ? "visit" : "interpolated" });
    }
    // Local midnights inside the stay always get a point, so each day's trace reaches its end: at the nearer recorded
    // point inside the visit when one is close enough to interpolate from, otherwise at the visit.
    for (const t of cutsHere) {
      if (claimed.some(([a, b]) => t >= a && t <= b) || times.includes(t)) continue;
      const i = after(t);
      const near = [real[i - 1], real[i]].filter((p): p is TrackPoint => inside(p) && Math.abs(p.t - t) <= MAX_INTERPOLATION_GAP_MS);
      const at = near.length ? near.reduce((a, b) => (Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b)) : s;
      filler.push({ t, lat: at.lat, lng: at.lng, filled: at === s ? "visit" : "interpolated" });
    }
    // A gap just over the interpolation limit that reaches into the visit can fall between the steps (and between
    // the visit's end and the next recorded point): wherever a stretch of it is still too long to interpolate across,
    // even after the steps, fill the middle of that stretch's part inside the visit.
    if (s.fill && end > s.start) {
      for (let i = Math.max(0, after(s.start) - 1); i + 1 < real.length && real[i].t <= end; i++) {
        const a = real[i], b = real[i + 1];
        if (b.t < s.start || b.t - a.t <= MAX_INTERPOLATION_GAP_MS) continue;
        const marks = [a.t, ...filler.filter((f) => f.t > a.t && f.t < b.t).map((f) => f.t).sort((x, y) => x - y), b.t];
        const at = inside(a) ? a : inside(b) ? b : s;
        for (let k = 0; k + 1 < marks.length; k++) {
          if (marks[k + 1] - marks[k] <= MAX_INTERPOLATION_GAP_MS) continue;
          const lo = Math.max(marks[k], s.start), hi = Math.min(marks[k + 1], end);
          if (lo >= hi) continue;
          const mid = Math.round((lo + hi) / 2);
          if (mid < window.startMs || mid > window.endMs || claimed.some(([x, y]) => mid >= x && mid <= y)) continue;
          filler.push({ t: mid, lat: at.lat, lng: at.lng, filled: at === s ? "visit" : "interpolated" });
        }
      }
      claimed.push([s.start, end]);
    }
  }
  return [...real, ...filler].sort((a, b) => a.t - b.t);
}
