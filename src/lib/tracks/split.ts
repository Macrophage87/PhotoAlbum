import { localDayInZone, type LocalDay } from "@/lib/time/local-day";
import type { TrackPoint } from "./types";
import { MAX_INTERPOLATION_GAP_MS, MAX_SNAP_MS } from "./interpolate";

const BUCKET_MS = 15 * 60_000; // every real-world UTC offset is a multiple of 15 minutes

/**
 * Group time-ordered points by local calendar day (in the trip's zone), preserving order. A day also ends on the
 * next day's first point when that is close enough to place a photograph between them: a photograph is placed only
 * inside one track's time range, so without that shared point the stretch across midnight (23:55 to 00:04, say)
 * would belong to neither day's track. A longer gap (a night indoors, a flight) gets no connector, which would only
 * draw a line across it and add its distance to the day.
 */
export function splitByLocalDay(points: TrackPoint[], timezone: string): Map<LocalDay, TrackPoint[]> {
  const out = new Map<LocalDay, TrackPoint[]>();
  const bucketDay = new Map<number, LocalDay>();
  for (const p of points) {
    const bucket = Math.floor(p.t / BUCKET_MS);
    let day = bucketDay.get(bucket);
    if (!day) {
      day = localDayInZone(new Date(bucket * BUCKET_MS), timezone);
      bucketDay.set(bucket, day);
    }
    const list = out.get(day);
    if (list) list.push(p);
    else out.set(day, [p]);
  }
  const days = [...out.values()];
  for (let i = 0; i + 1 < days.length; i++) {
    const last = days[i][days[i].length - 1], next = days[i + 1][0];
    // A day of one point is skipped on import anyway; a connector would make it a track of nothing but the gap.
    if (days[i].length > 1 && next.t - last.t <= MAX_INTERPOLATION_GAP_MS + MAX_SNAP_MS) days[i].push(next);
  }
  return out;
}
