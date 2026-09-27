import { Prisma } from "@/generated/prisma/client";

/**
 * The wall-clock time a photograph was taken, in SQL, by the rule `photoDay` applies (see local-day.ts): on its own
 * offset when it has one, else in its trip's zone, else UTC. `photo` and `trip` are the aliases in the query; the
 * trip is LEFT JOINed, so an item on no trip reads as UTC. `takenAt` is a UTC timestamp without a zone, so it is
 * first said to be UTC and then read in the trip's zone.
 */
export function localTakenAtSql(photo = "p", trip = "t"): Prisma.Sql {
  const p = Prisma.raw(photo);
  const t = Prisma.raw(trip);
  return Prisma.sql`(CASE WHEN ${p}."tzOffsetMin" IS NOT NULL THEN ${p}."takenAt" + make_interval(mins => ${p}."tzOffsetMin")
    ELSE (${p}."takenAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(${t}.timezone, 'UTC') END)`;
}

/** The year a photograph was taken where it was taken (see `localTakenAtSql`). */
export function localYearSql(photo = "p", trip = "t"): Prisma.Sql {
  return Prisma.sql`EXTRACT(YEAR FROM ${localTakenAtSql(photo, trip)})::int`;
}

/**
 * Photographs taken in `year` where they were taken.
 *
 * The local year is computed, so no index can answer it directly; the plain range on `takenAt` beside it can. No
 * offset is more than fourteen hours from UTC, so anything from the local year falls within a day either side of
 * that year in UTC: the range lets the planner use the index on `takenAt` (or on the trip and `takenAt`) to fetch
 * about a year's rows, and the local year is then read only on those.
 */
export function inLocalYearSql(year: number, photo = "p", trip = "t"): Prisma.Sql {
  const p = Prisma.raw(photo);
  return Prisma.sql`(${p}."takenAt" >= make_timestamp(${year}::int, 1, 1, 0, 0, 0) - interval '1 day'
    AND ${p}."takenAt" < make_timestamp(${year}::int + 1, 1, 1, 0, 0, 0) + interval '1 day'
    AND ${localYearSql(photo, trip)} = ${year}::int)`;
}
