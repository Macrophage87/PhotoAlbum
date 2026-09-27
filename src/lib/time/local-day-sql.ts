import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { normalizedTimezone } from "./local-day";

/** A trip zone Postgres does not know, and the one the SQL reads it in instead. */
export type ZoneFix = [stored: string, readAs: string];

let knownZones: Promise<Set<string>> | null = null;

/**
 * The zone names this database knows. `pg_timezone_names` reads the zone files, which costs more than the queries
 * that need it, and what it holds changes only with the server's tz data, so it is read once per process.
 */
function databaseZones(): Promise<Set<string>> {
  knownZones ??= db.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
    (rows) => new Set(rows.map((r) => r.name)),
    (err) => {
      knownZones = null;
      throw err;
    },
  );
  return knownZones;
}

/**
 * A zone for `AT TIME ZONE` that cannot fail the query: under the name Postgres knows it by (a renamed zone's old
 * name in its new one, a bare offset as the fixed-offset zone that says the same; see `normalizedTimezone`), or UTC
 * when this database does not know it at all.
 */
export async function databaseZone(tz: string): Promise<string> {
  const known = await databaseZones();
  const readAs = normalizedTimezone(tz);
  // A name Postgres knows is still read as the pages read it when they differ: 'CET' is a fixed offset to Postgres
  // but Europe/Brussels, with its summer time, to the pages.
  if (known.has(readAs)) return readAs;
  return known.has(tz) ? tz : "UTC";
}

/**
 * How to read the trips' zones this database does not know, or reads differently from the pages (see `databaseZone`), so that no trip's zone can fail a
 * query for the whole album: America/Buenos_Aires where Postgres was built without the legacy links, say. Normally
 * there are none: trips are saved under names Postgres knows (see `canonicalTimezone`), and older ones were tidied
 * by a migration. The trips' own zones are few and read each time.
 */
export async function tripZoneFixes(): Promise<ZoneFix[]> {
  const trips = await db.trip.findMany({ distinct: ["timezone"], select: { timezone: true } });
  const fixes = await Promise.all(trips.map(async (t): Promise<ZoneFix> => [t.timezone, await databaseZone(t.timezone)]));
  return fixes.filter(([stored, readAs]) => stored !== readAs);
}

/**
 * The wall-clock time a photograph was taken, in SQL, by the rule `photoDay` applies (see local-day.ts): on its own
 * offset when it has one, else in its trip's zone, else UTC. `photo` and `trip` are the aliases in the query; the
 * trip is LEFT JOINed, so an item on no trip reads as UTC. `takenAt` is a UTC timestamp without a zone, so it is
 * first said to be UTC and then read in the trip's zone. `fixes` is `tripZoneFixes()`: normally empty, and then the
 * query carries no check at all.
 */
export function localTakenAtSql(fixes: ZoneFix[], photo = "p", trip = "t"): Prisma.Sql {
  const p = Prisma.raw(photo);
  const t = Prisma.raw(trip);
  const zone = fixes.length
    ? Prisma.sql`CASE ${t}.timezone ${Prisma.join(fixes.map(([stored, readAs]) => Prisma.sql`WHEN ${stored} THEN ${readAs}`), " ")} ELSE COALESCE(${t}.timezone, 'UTC') END`
    : Prisma.sql`COALESCE(${t}.timezone, 'UTC')`;
  return Prisma.sql`(CASE WHEN ${p}."tzOffsetMin" IS NOT NULL THEN ${p}."takenAt" + make_interval(mins => ${p}."tzOffsetMin")
    ELSE (${p}."takenAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone} END)`;
}

/** The year a photograph was taken where it was taken (see `localTakenAtSql`). */
export function localYearSql(fixes: ZoneFix[], photo = "p", trip = "t"): Prisma.Sql {
  return Prisma.sql`EXTRACT(YEAR FROM ${localTakenAtSql(fixes, photo, trip)})::int`;
}

/** Years a filter can ask about: the range Postgres can build a timestamp for, with a day's room either side. */
const YEAR_MIN = 1;
const YEAR_MAX = 9998;

/**
 * Photographs taken in `year` where they were taken.
 *
 * The local year is computed, so no index can answer it directly; the plain range on `takenAt` beside it can. No
 * offset is more than fourteen hours from UTC, so anything from the local year falls within a day either side of
 * that year in UTC: the range lets the planner use the index on `takenAt` (or on the trip and `takenAt`) to fetch
 * about a year's rows, and the local year is then read only on those. A year outside what a timestamp can hold
 * matches nothing, rather than failing the query.
 */
export function inLocalYearSql(year: number, fixes: ZoneFix[], photo = "p", trip = "t"): Prisma.Sql {
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return Prisma.sql`FALSE`;
  const p = Prisma.raw(photo);
  return Prisma.sql`(${p}."takenAt" >= make_timestamp(${year}::int, 1, 1, 0, 0, 0) - interval '1 day'
    AND ${p}."takenAt" < make_timestamp(${year}::int + 1, 1, 1, 0, 0, 0) + interval '1 day'
    AND ${localYearSql(fixes, photo, trip)} = ${year}::int)`;
}
