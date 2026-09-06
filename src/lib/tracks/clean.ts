import { isValidCoord } from "@/lib/geo/bounds";
import type { TrackPoint } from "./types";

/** Sort by time, drop invalid coordinates, duplicate timestamps and NaN times. */
export function cleanPoints(points: TrackPoint[]): TrackPoint[] {
  const valid = points.filter((p) => Number.isFinite(p.t) && isValidCoord(p.lat, p.lng));
  valid.sort((a, b) => a.t - b.t);
  const out: TrackPoint[] = [];
  let lastT = -Infinity;
  for (const p of valid) {
    if (p.t === lastT) continue;
    out.push(p);
    lastT = p.t;
  }
  return out;
}
