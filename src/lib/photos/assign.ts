import type { LocalDay } from "@/lib/time/local-day";
import { dateColumnToDay } from "@/lib/time/local-day";

export type TripDateRange = { id: string; startDate: Date; endDate: Date };

/** The single trip whose date range contains `day`; null when none or ambiguous. */
export function pickTripByDay<T extends TripDateRange>(trips: T[], day: LocalDay): T | null {
  const matches = trips.filter((t) => dateColumnToDay(t.startDate) <= day && day <= dateColumnToDay(t.endDate));
  return matches.length === 1 ? matches[0] : null;
}

export type ActivityWindow = { id: string; startTime: Date; endTime: Date };

/** Activity whose time window contains the instant; the shortest window wins if they overlap. */
export function pickActivityByTime<T extends ActivityWindow>(activities: T[], instant: Date): T | null {
  const t = instant.getTime();
  const matches = activities.filter((a) => a.startTime.getTime() <= t && t <= a.endTime.getTime());
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.endTime.getTime() - a.startTime.getTime() - (b.endTime.getTime() - b.startTime.getTime()));
  return matches[0];
}
