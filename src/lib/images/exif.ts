import exifr from "exifr";
import { timezoneForCoords } from "@/lib/geo/tz";
import {
  offsetMinutesInZone,
  parseOffsetString,
  wallTimeToInstant,
  wallTimeWithOffsetToInstant,
} from "@/lib/time/local-day";
import type { TakenAtSource } from "@/generated/prisma/enums";

export type ExifSummary = {
  dateTimeOriginal: string | null; // "YYYY:MM:DD HH:MM:SS" wall time
  subSec: string | null;
  offsetTimeOriginal: string | null; // "+02:00"
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  orientation: number | null;
  exposureTime: number | null;
  fNumber: number | null;
  iso: number | null;
  focalLength: number | null;
};

const PICK = [
  "DateTimeOriginal",
  "CreateDate",
  "DateTimeDigitized",
  "SubSecTimeOriginal",
  "OffsetTimeOriginal",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
  "GPSAltitude",
  "GPSAltitudeRef",
  "Make",
  "Model",
  "LensModel",
  "ExposureTime",
  "FNumber",
  "ISO",
  "FocalLength",
  "Orientation",
];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Read the subset of EXIF the album cares about. Dates stay as raw strings so we control the timezone. */
export async function readExif(input: string | Buffer): Promise<ExifSummary> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await exifr.parse(input, {
      reviveValues: false,
      translateKeys: true,
      translateValues: false,
      tiff: true,
      exif: true,
      gps: true,
      pick: PICK,
    });
  } catch {
    raw = undefined;
  }
  const r = raw ?? {};
  let altitude = num(r.GPSAltitude);
  const altRef = r.GPSAltitudeRef;
  if (altitude !== null && (altRef === 1 || (typeof altRef === "object" && altRef !== null && (altRef as Record<string, unknown>)["0"] === 1))) {
    altitude = -altitude;
  }
  const lat = num(r.latitude);
  const lng = num(r.longitude);
  return {
    // DateTimeOriginal is when the shutter fired; CreateDate (DateTimeDigitized) is the same moment on a camera and
    // survives some of the re-encoding that strips the first, so it stands in rather than falling through to the file.
    dateTimeOriginal: str(r.DateTimeOriginal) ?? str(r.CreateDate) ?? str(r.DateTimeDigitized),
    subSec: str(r.SubSecTimeOriginal),
    offsetTimeOriginal: str(r.OffsetTimeOriginal),
    lat: lat !== null && lng !== null && (lat !== 0 || lng !== 0) ? lat : null,
    lng: lat !== null && lng !== null && (lat !== 0 || lng !== 0) ? lng : null,
    altitude,
    make: str(r.Make),
    model: str(r.Model),
    lens: str(r.LensModel),
    orientation: num(r.Orientation),
    exposureTime: num(r.ExposureTime),
    fNumber: num(r.FNumber),
    iso: num(r.ISO),
    focalLength: num(r.FocalLength),
  };
}

export type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; ms?: number };

/** Parse EXIF "YYYY:MM:DD HH:MM:SS" (tolerating dashes) into wall-clock fields. */
export function parseExifWallTime(s: string, subSec?: string | null): WallTime | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
    ms: subSec ? Math.round(Number(`0.${subSec}`) * 1000) : 0,
  };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31 || wall.hour > 23 || wall.minute > 59 || wall.second > 60) return null;
  return wall;
}

export type TakenAtResolution = { takenAt: Date; tzOffsetMin: number; source: TakenAtSource; wallDay: string };

/**
 * Turn an EXIF wall time into a UTC instant.
 * Order: explicit EXIF offset -> zone from GPS -> the trip's zone (or UTC when unknown).
 */
export function resolveTakenAt(
  exif: Pick<ExifSummary, "dateTimeOriginal" | "subSec" | "offsetTimeOriginal" | "lat" | "lng">,
  tripTimezone: string | null,
): TakenAtResolution | null {
  if (!exif.dateTimeOriginal) return null;
  const wall = parseExifWallTime(exif.dateTimeOriginal, exif.subSec);
  if (!wall) return null;
  const wallDay = `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;

  const offset = exif.offsetTimeOriginal ? parseOffsetString(exif.offsetTimeOriginal) : null;
  if (offset !== null) {
    return { takenAt: wallTimeWithOffsetToInstant(wall, offset), tzOffsetMin: offset, source: "EXIF_OFFSET", wallDay };
  }

  const zoneFromGps = exif.lat !== null && exif.lng !== null ? timezoneForCoords(exif.lat, exif.lng) : null;
  if (zoneFromGps) {
    const takenAt = wallTimeToInstant(wall, zoneFromGps);
    return { takenAt, tzOffsetMin: offsetMinutesInZone(takenAt, zoneFromGps), source: "EXIF_TZLOOKUP", wallDay };
  }

  const zone = tripTimezone ?? "UTC";
  const takenAt = wallTimeToInstant(wall, zone);
  return { takenAt, tzOffsetMin: offsetMinutesInZone(takenAt, zone), source: "TRIP_TZ", wallDay };
}

export function cameraLabel(exif: Pick<ExifSummary, "make" | "model">): string | null {
  const make = exif.make?.trim();
  const model = exif.model?.trim();
  if (!make && !model) return null;
  if (make && model && model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return [make, model].filter(Boolean).join(" ");
}
