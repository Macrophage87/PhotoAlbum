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
