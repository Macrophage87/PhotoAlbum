import type { TrackPoint } from "./types";

export const MAX_INTERPOLATION_GAP_MS = 10 * 60_000;
export const MAX_SNAP_MS = 5 * 60_000;

/** Position at an instant along a time-sorted track, or null when the track doesn't cover it. */
export function positionAt(points: TrackPoint[], tMs: number): { lat: number; lng: number; ele?: number } | null {
  const n = points.length;
  if (n === 0) return null;
  if (tMs < points[0].t || tMs > points[n - 1].t) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo];
  if (a.t === tMs || lo === n - 1) return { lat: a.lat, lng: a.lng, ele: a.ele };
  const b = points[lo + 1];
  const gap = b.t - a.t;
  if (gap <= MAX_INTERPOLATION_GAP_MS) {
    const f = (tMs - a.t) / gap;
    const ele = a.ele !== undefined && b.ele !== undefined ? a.ele + (b.ele - a.ele) * f : undefined;
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, ele };
  }
  const nearer = tMs - a.t <= b.t - tMs ? a : b;
  if (Math.abs(nearer.t - tMs) <= MAX_SNAP_MS) return { lat: nearer.lat, lng: nearer.lng, ele: nearer.ele };
  return null;
}

/**
 * How much a track's position at an instant says about where the person was:
 * - "firm": a recorded fix, or interpolated between two recorded fixes (within MAX_INTERPOLATION_GAP_MS of each other);
 * - "visit": drawn from points filled in at a Google visit's place, which may be the middle of somewhere big;
 * - "soft": snapped across a signal gap, or drawn from points the importer interpolated itself.
 * Null where the track has no position at all.
 */
export type PositionKind = "firm" | "visit" | "soft";

export function positionKindAt(points: TrackPoint[], tMs: number): PositionKind | null {
  const n = points.length;
  if (n === 0 || tMs < points[0].t || tMs > points[n - 1].t) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const kindOf = (p: TrackPoint): PositionKind => (p.filled === "visit" ? "visit" : p.filled ? "soft" : "firm");
  const a = points[lo];
  if (a.t === tMs || lo === n - 1) return kindOf(a);
  const b = points[lo + 1];
  if (b.t - a.t > MAX_INTERPOLATION_GAP_MS) return Math.min(tMs - a.t, b.t - tMs) <= MAX_SNAP_MS ? "soft" : null;
  const kinds = [kindOf(a), kindOf(b)];
  return kinds.includes("soft") ? "soft" : kinds.includes("visit") ? "visit" : "firm";
}
