import { db } from "@/lib/db";
import { whoWasThere } from "@/lib/photos/assign";

/**
 * The trip a photograph belongs to when none of the uploader's trips has its day: the single one with an activity
 * or a track running at its instant. A ride on a trip's last evening that goes on past midnight takes photographs
 * dated the day after the trip ends, and one that sets out at 23:30 the evening before its first day takes some the
 * day before it begins; both belong to the trip all the same, and to the ride. An activity counts only where this
 * uploader may be filed on it (see `whoWasThere`); a track is the trip's record whoever brought it. Where several
 * trips are running at that moment, or none is, there is no answer.
 *
 * `instantIn` gives the instant as read in each trip's zone, for a camera clock that says no zone of its own; one
 * that does gives the same instant for every trip.
 */
export async function pickTripByCoverage<T extends { id: string }>(trips: T[], uploaderId: string, instantIn: (trip: T) => Date | null): Promise<T | null> {
  const at = new Map<string, number>();
  for (const t of trips) {
    const ms = instantIn(t)?.getTime();
    if (ms !== undefined && Number.isFinite(ms)) at.set(t.id, ms);
  }
  if (!at.size) return null;
  const tripIds = [...at.keys()], times = [...at.values()];
  const from = new Date(Math.min(...times)), to = new Date(Math.max(...times));
  const window = { tripId: { in: tripIds }, startTime: { lte: to }, endTime: { gte: from } };
  const select = { tripId: true, startTime: true, endTime: true } as const;
  const [activities, tracks] = await Promise.all([
    db.activity.findMany({ where: { ...window, ...whoWasThere(uploaderId) }, select }),
    db.track.findMany({ where: window, select }),
  ]);
  const running = new Set<string>();
  for (const w of [...activities, ...tracks]) {
    const t = at.get(w.tripId)!;
    if (w.startTime.getTime() <= t && t <= w.endTime.getTime()) running.add(w.tripId);
  }
  if (running.size !== 1) return null;
  const [id] = running;
  return trips.find((t) => t.id === id) ?? null;
}
