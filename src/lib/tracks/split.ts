import { localDayInZone, wallTimeToInstant, type LocalDay } from "@/lib/time/local-day";
import { MAX_INTERPOLATION_GAP_MS, MAX_SNAP_MS } from "./interpolate";
import type { TrackPoint } from "./types";

const BUCKET_MS = 15 * 60_000; // every real-world UTC offset is a multiple of 15 minutes

/** A point on the straight line from a to b at instant t. */
function between(a: TrackPoint, b: TrackPoint, t: number): TrackPoint {
  const f = (t - a.t) / (b.t - a.t);
  // Between two points of the same visit it is still the visit; anywhere else it is the importer's own guess.
  const filled = a.filled === "visit" && b.filled === "visit" ? "visit" : "interpolated";
  const p: TrackPoint = { t, lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, filled };
  if (a.ele !== undefined && b.ele !== undefined) p.ele = a.ele + (b.ele - a.ele) * f;
  return p;
}

/**
 * Group time-ordered points by local calendar day (in the trip's zone), preserving order. Where the points either
 * side of a local midnight are close enough to interpolate between, the day ends on a point at the last instant
 * before midnight and the next begins on one at midnight, so a photograph taken at 23:59 is still inside one day's
 * track. Where they are a little further apart than that but still close enough to place a photograph between them
 * (within the snap window), the day instead ends on the next day's first point: a photograph is placed only inside
 * one track's time range, so without that shared point the stretch across midnight would belong to neither day's
 * track. A longer gap (a night indoors, a flight) is left as a gap: a connector would only draw a line across it
 * and add its distance to the day.
 */
export function splitByLocalDay(points: TrackPoint[], timezone: string): Map<LocalDay, TrackPoint[]> {
  const out = new Map<LocalDay, TrackPoint[]>();
  const bucketDay = new Map<number, LocalDay>();
  let prev: TrackPoint | undefined, prevDay: LocalDay | undefined;
  for (const p of points) {
    const bucket = Math.floor(p.t / BUCKET_MS);
    let day = bucketDay.get(bucket);
    if (!day) {
      day = localDayInZone(new Date(bucket * BUCKET_MS), timezone);
      bucketDay.set(bucket, day);
    }
    let list = out.get(day);
    if (!list) out.set(day, (list = []));
    if (prev && prevDay && day !== prevDay && p.t - prev.t <= MAX_INTERPOLATION_GAP_MS) {
      const [y, m, d] = day.split("-").map(Number);
      const midnight = wallTimeToInstant({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timezone).getTime();
      if (midnight - 1 > prev.t && midnight - 1 < p.t) out.get(prevDay)!.push(between(prev, p, midnight - 1));
      if (midnight > prev.t && midnight < p.t) list.push(between(prev, p, midnight));
    }
    list.push(p);
    prev = p;
    prevDay = day;
  }
  const days = [...out.values()];
  for (let i = 0; i + 1 < days.length; i++) {
    const last = days[i][days[i].length - 1], next = days[i + 1][0];
    const gap = next.t - last.t;
    // Already joined at midnight above (the last instant before it, then midnight itself): nothing to bridge.
    if (gap <= 1) continue;
    // A day of one point is skipped on import anyway; a connector would make it a track of nothing but the gap.
    if (days[i].length > 1 && gap <= MAX_INTERPOLATION_GAP_MS + MAX_SNAP_MS) days[i].push(next);
  }
  return out;
}
