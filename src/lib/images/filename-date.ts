import type { TakenAtResolution, WallTime } from "./exif";
import { offsetMinutesInZone, wallTimeToInstant } from "@/lib/time/local-day";

/**
 * The capture time phones write into the file name. When a photo reaches the album with its EXIF stripped — a
 * screenshot, a file sent through a chat app, a copy made by a file manager, anything Android re-encoded on the way
 * out — the name is very often the only honest record of when it was taken, and the file's modified time is just
 * when it was copied. So the name is read before falling back to that.
 *
 * Handles the shapes phones and desktops actually produce:
 *   IMG_20250812_143015.jpg          PXL_20250812_143015123.MP.jpg     VID_20250812_143015.mp4
 *   20250812_143015.jpg              IMG-20250812-WA0001.jpg           Screenshot_2025-08-12-14-30-15.png
 *   Screenshot 2025-08-12 at 14.30.15.png                              photo_2025-08-12_14-30-15.jpg
 *   2025-08-12 14.30.15.jpg          signal-2025-08-12-143015.jpg
 */
// The trailing group swallows the milliseconds a Pixel writes (PXL_20250812_143015123), which would otherwise make
// the seconds look like part of a longer number and throw the whole match away.
const DATE_TIME = /(?<![0-9])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_.\sT]|\sat\s)+(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?:\.?\d{1,3})?(?![0-9])/;
const DATE_ONLY = /(?<![0-9])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?![0-9])/;

/** Anything outside this is somebody's serial number, not a date. */
const MIN_YEAR = 1900;

function valid(w: WallTime): boolean {
  const year = new Date().getUTCFullYear() + 1;
  if (w.year < MIN_YEAR || w.year > year) return false;
  if (w.month < 1 || w.month > 12 || w.day < 1 || w.day > 31) return false;
  if (w.hour > 23 || w.minute > 59 || w.second > 59) return false;
  // Reject a day the month does not have (30 February is a serial number, not a date).
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  return d.getUTCMonth() === w.month - 1 && d.getUTCDate() === w.day;
}

/** The wall-clock time a file name claims, or null when it does not claim one. No time of day means midnight. */
export function wallTimeFromFilename(name: string): WallTime | null {
  const withTime = DATE_TIME.exec(name);
  if (withTime) {
    const w = { year: +withTime[1], month: +withTime[2], day: +withTime[3], hour: +withTime[4], minute: +withTime[5], second: +withTime[6] };
    if (valid(w)) return w;
  }
  const dateOnly = DATE_ONLY.exec(name);
  if (dateOnly) {
    const w = { year: +dateOnly[1], month: +dateOnly[2], day: +dateOnly[3], hour: 0, minute: 0, second: 0 };
    if (valid(w)) return w;
  }
  return null;
}

/**
 * Turn a name's claim into an instant. The name carries no time zone, so it is read in the trip's zone when one is
 * known and in UTC otherwise — the same treatment an EXIF time without an offset gets.
 */
export function resolveFilenameTakenAt(name: string, tripTimezone: string | null): TakenAtResolution | null {
  const wall = wallTimeFromFilename(name);
  if (!wall) return null;
  const zone = tripTimezone ?? "UTC";
  const takenAt = wallTimeToInstant(wall, zone);
  return {
    takenAt,
    tzOffsetMin: offsetMinutesInZone(takenAt, zone),
    source: "FILE_NAME",
    wallDay: `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`,
  };
}
