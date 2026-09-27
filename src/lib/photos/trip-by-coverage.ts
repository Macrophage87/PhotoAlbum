import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { whoWasThere } from "@/lib/photos/assign";
import { TRUSTED_TIME_SOURCES } from "@/lib/photos/date-from-neighbours";
import { dateColumnToDay, localDayInZone } from "@/lib/time/local-day";
import type { TakenAtSource } from "@/generated/prisma/enums";

const DAY_MS = 86_400_000;

/**
 * The trip a photograph belongs to when none of the uploader's trips has its day: the single one with an activity
 * or a track running at its instant. A ride on a trip's last evening that goes on past midnight takes photographs
 * dated the day after the trip ends, and one that sets out at 23:30 the evening before its first day takes some the
 * day before it begins; both belong to the trip all the same, and to the ride. An activity counts only where this
 * uploader may be filed on it (see `whoWasThere`); a track is the trip's record whoever brought it. Where several
 * trips are running at that moment, or none is, there is no answer.
 *
 * Only those two days are looked at: the day before a trip's first and the day after its last, in the trip's zone.
 * A track imported into the wrong trip, or an activity whose year was mistyped, is not a reason to pull in a
 * photograph from some other week. And only a date the album trusts enough to place a photograph on a track by
 * (`TRUSTED_TIME_SOURCES`, as geotagging uses): a file's modified time or the upload time says nothing about which
 * ride it was.
 *
 * `instantIn` gives the instant as read in each trip's zone, and where it came from, for a camera clock that says no
 * zone of its own; one that does gives the same instant for every trip. `client` is the transaction to read in, when
 * the caller holds the photo's row locked (see member-owned).
 */
export async function pickTripByCoverage<T extends { id: string; startDate: Date; endDate: Date; timezone: string }>(
  trips: T[],
  uploaderId: string,
  instantIn: (trip: T) => { takenAt: Date | null; source: TakenAtSource | null } | null,
  client: Prisma.TransactionClient = db,
): Promise<T | null> {
  const at = new Map<string, number>();
  for (const t of trips) {
    const read = instantIn(t);
    const ms = read?.takenAt?.getTime();
    if (ms === undefined || !Number.isFinite(ms) || !read!.source || !TRUSTED_TIME_SOURCES.includes(read!.source)) continue;
    const day = localDayInZone(read!.takenAt!, t.timezone);
    if (day === dateColumnToDay(new Date(t.startDate.getTime() - DAY_MS)) || day === dateColumnToDay(new Date(t.endDate.getTime() + DAY_MS))) at.set(t.id, ms);
  }
  if (!at.size) return null;
  const tripIds = [...at.keys()], times = [...at.values()];
  const from = new Date(Math.min(...times)), to = new Date(Math.max(...times));
  const window = { tripId: { in: tripIds }, startTime: { lte: to }, endTime: { gte: from } };
  const select = { tripId: true, startTime: true, endTime: true } as const;
  const [activities, tracks] = await Promise.all([
    client.activity.findMany({ where: { ...window, ...whoWasThere(uploaderId) }, select }),
    client.track.findMany({ where: window, select }),
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
