import { localDayInZone, type LocalDay } from "@/lib/time/local-day";
import type { TrackPoint } from "./types";

const BUCKET_MS = 15 * 60_000; // every real-world UTC offset is a multiple of 15 minutes

/** Group points by local calendar day (in the trip's zone), preserving order. */
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
  return out;
}
