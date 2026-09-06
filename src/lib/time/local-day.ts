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

/** Parse "+02:00" / "-0400" style offsets into minutes east of UTC. */
export function parseOffsetString(s: string): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
