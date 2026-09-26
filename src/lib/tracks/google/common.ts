import { MAX_INTERPOLATION_GAP_MS } from "../interpolate";
import type { TrackPoint } from "../types";

export type Window = { startMs: number; endMs: number };
export const MAX_ACCURACY_M = 200;

/** "44.3500000°, -68.2000000°" or "geo:44.35,-68.2" -> [lat, lng] */
export function parseLatLng(s: unknown): [number, number] | null {
  if (typeof s !== "string") return null;
  const m = /(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)°?/.exec(s.replace(/^geo:/, ""));
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

export function e7(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v / 1e7 : null;
}

/** ISO string or "1700000000000" ms string/number -> epoch ms */
export function parseTime(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v) return null;
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function inWindow(t: number, w: Window): boolean {
  return t >= w.startMs && t <= w.endMs;
}

export function point(t: number, lat: number, lng: number, extra?: { ele?: number }): TrackPoint {
  const p: TrackPoint = { t, lat, lng };
  if (extra?.ele !== undefined) p.ele = extra.ele;
  return p;
}

/** Spacing of the points a stay is filled with: close enough that positionAt interpolates between them. */
export const STAY_STEP_MS = MAX_INTERPOLATION_GAP_MS / 2;

/**
 * Points for a visit: Google says the person was at this one spot from start to end, so the whole stay is covered,
 * not just its two ends (a photo in the middle of a three-hour museum visit would otherwise fall into a gap too long
 * to interpolate across). Only the part inside the window is filled.
 */
export function stayPoints(start: number | null, end: number | null, lat: number, lng: number, window: Window): TrackPoint[] {
  if (start === null) return [];
  if (end === null || end <= start) return inWindow(start, window) ? [point(start, lat, lng)] : [];
  const from = Math.max(start, window.startMs), to = Math.min(end, window.endMs);
  if (from > to) return [];
  const out: TrackPoint[] = [];
  for (let t = from; t < to; t += STAY_STEP_MS) out.push(point(t, lat, lng));
  out.push(point(to, lat, lng));
  return out;
}
