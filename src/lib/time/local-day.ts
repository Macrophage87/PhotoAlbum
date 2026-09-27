import { TZDate } from "@date-fns/tz";

export type LocalDay = string; // "YYYY-MM-DD"

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day for an instant given a fixed UTC offset in minutes. */
export function localDayFromOffset(instant: Date, tzOffsetMin: number): LocalDay {
  const shifted = new Date(instant.getTime() + tzOffsetMin * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Local calendar day for an instant in an IANA zone. */
export function localDayInZone(instant: Date, timezone: string): LocalDay {
  const z = new TZDate(instant, timezone);
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`;
}

/** The offset a photograph's clock is read on (see photoDay): its own, else the trip's zone at that instant, else UTC. */
export function photoOffsetMin(instant: Date, tzOffsetMin: number | null, timezone?: string | null): number {
  return tzOffsetMin ?? (timezone ? offsetMinutesInZone(instant, timezone) : 0);
}

/**
 * The instant and offset for a wall-clock time typed for a photograph: on its own offset when it has one, else in
 * the trip's zone (resolved as a wall time, so a date across a DST change gets that day's offset), else UTC.
 */
export function photoWallTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms?: number },
  tzOffsetMin: number | null,
  timezone?: string | null,
): { takenAt: Date; tzOffsetMin: number } {
  if (tzOffsetMin === null && timezone) {
    const takenAt = wallTimeToInstant(wall, timezone);
    return { takenAt, tzOffsetMin: offsetMinutesInZone(takenAt, timezone) };
  }
  return { takenAt: wallTimeWithOffsetToInstant(wall, tzOffsetMin ?? 0), tzOffsetMin: tzOffsetMin ?? 0 };
}

/**
 * Today's date on the clock of whoever is running this: for a default typed into a form in the browser, where
 * `toISOString().slice(0, 10)` would be the UTC day (tomorrow, on an American evening). Not for server rendering.
 */
export function localToday(now = new Date()): LocalDay {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** UTC offset (minutes east of UTC) that `timezone` has at `instant`. */
export function offsetMinutesInZone(instant: Date, timezone: string): number {
  return -new TZDate(instant, timezone).getTimezoneOffset();
}

/** Interpret a wall-clock time in `timezone` and return the UTC instant. */
export function wallTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms?: number },
  timezone: string,
): Date {
  const z = new TZDate(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms ?? 0, timezone);
  return new Date(z.getTime());
}

/** Interpret a wall-clock time with a fixed offset (minutes east of UTC). */
export function wallTimeWithOffsetToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms?: number },
  tzOffsetMin: number,
): Date {
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms ?? 0);
  return new Date(utc - tzOffsetMin * 60_000);
}

/** Prisma `@db.Date` columns come back as UTC midnight; turn them into a LocalDay key. */
export function dateColumnToDay(d: Date): LocalDay {
  return d.toISOString().slice(0, 10);
}

export function dayToDateColumn(day: LocalDay): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** No clock on Earth is further from UTC than this (Kiribati's +14:00; Baker Island's -12:00 is inside it). */
export const MAX_OFFSET_MIN = 14 * 60;

/** Parse "+02:00" / "-0400" style offsets into minutes east of UTC; anything no clock could read is no offset. */
export function parseOffsetString(s: string): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (!m || Number(m[3]) >= 60) return null;
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return Math.abs(minutes) <= MAX_OFFSET_MIN ? minutes : null;
}

/**
 * Zones the Unicode data (and so every browser's Intl) still calls by an old name after the tz database renamed
 * them. The old names are links there now, and a Postgres built without the legacy links (Debian's tzdata-legacy
 * split) does not know them at all, so a trip is always saved under the new one.
 */
const RENAMED_ZONES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

let namedZones: Set<string> | null = null;

/**
 * The tz database's own name for a zone, or null when it is not a named zone at all. A link is followed to the zone
 * it names ("US/Pacific" is "America/Los_Angeles", "Europe/Kiev" is "Europe/Kyiv"); a bare offset like "+05:00" is
 * refused, because Postgres reads one as a POSIX zone with the sign the other way round, so the album's SQL and its
 * pages would disagree about which day a photograph was taken.
 */
export function canonicalTimezone(tz: string): string | null {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // UTC and the tz database's fixed-offset zones (Etc/GMT-5 is five hours east), which Postgres reads the same way.
  if (resolved === "UTC" || /^Etc\/GMT[+-]\d{1,2}$/.test(resolved)) return resolved;
  namedZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  if (!namedZones.has(resolved)) return null;
  return RENAMED_ZONES[resolved] ?? resolved;
}

export function isValidTimezone(tz: string): boolean {
  return canonicalTimezone(tz) !== null;
}

/**
 * A zone as it should be kept (see `canonicalTimezone`), for one saved before names were checked. A bare offset
 * becomes the fixed-offset zone that says the same ("+05:00" is Etc/GMT-5: the tz database's signs run the POSIX
 * way); one with no such zone, or a name nothing knows, becomes UTC.
 */
export function normalizedTimezone(tz: string): string {
  const named = canonicalTimezone(tz);
  if (named) return named;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
  const offset = parseOffsetString(resolved);
  if (offset === null || offset % 60 !== 0) return "UTC";
  const hours = offset / 60;
  return canonicalTimezone(hours === 0 ? "UTC" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`) ?? "UTC";
}

/**
 * The day a photograph was taken, as the album shows it everywhere: on its own clock (the offset it was taken at)
 * when that is known, else in the trip's zone, else UTC. Timelines, day lists and the photo page all use this rule.
 */
export function photoDay(takenAt: Date, tzOffsetMin: number | null, timezone = "UTC"): LocalDay {
  return tzOffsetMin !== null ? localDayFromOffset(takenAt, tzOffsetMin) : localDayInZone(takenAt, timezone);
}
