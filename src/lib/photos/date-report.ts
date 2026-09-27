import { db } from "@/lib/db";
import { readExif, resolveDigitizedTakenAt, resolveTakenAt } from "@/lib/images/exif";
import { resolveFilenameTakenAt } from "@/lib/images/filename-date";
import { storage } from "@/lib/storage";
import { isWeakDate } from "./date-from-neighbours";
import { guessDateFromTrip } from "./date-guess-query";
import { photoOffsetMin } from "@/lib/time/local-day";

/**
 * Where a photo's date came from, and what else the album knows that disagrees.
 *
 * A scan is the case that needs this most: the scanner writes today's date into the file, so a print from 1974
 * arrives claiming to be from this week and nothing about the picture says otherwise. Rather than making a member
 * guess which of the album's rules produced that, this lays out every witness side by side and lets them choose.
 */
export type DateWitness = {
  key: string;
  label: string;
  /** What this witness says, as an instant, or null when it has nothing to say. */
  at: Date | null;
  /**
   * The offset the witness's clock was read on, for a wall time (the camera's own, else its GPS zone, else the trip's,
   * as processing reads it). Null for an instant that says no zone of its own, which is shown on the item's clock.
   */
  tzOffsetMin: number | null;
  /**
   * The offset the reading is shown on: its own when it has one, else the item's clock (its offset, else the trip's
   * zone at that instant, else UTC), which is also the one it would be recorded with if taken.
   */
  shownOffsetMin: number | null;
  /** Why it is worth what it is worth. */
  note: string;
  /** Whether this is where the item's current date came from. */
  current: boolean;
  /** Whether a member can take this reading in one press. */
  usable: boolean;
};

export type DateReport = {
  photoId: string;
  current: { at: Date | null; source: string | null; tzOffsetMin: number | null; /** See DateWitness. */ shownOffsetMin: number | null; setBy: string | null };
  weak: boolean;
  witnesses: DateWitness[];
  /** Said plainly when the evidence points at a scan rather than a photograph taken that day. */
  looksScanned: boolean;
};

const LABEL: Record<string, string> = {
  EXIF_OFFSET: "the camera, with its time zone",
  EXIF_TZLOOKUP: "the camera, placed by its GPS",
  TRIP_TZ: "the camera, read in the trip's zone",
  FILE_NAME: "the file name",
  EXIF_CREATED: "the file's created-date tag",
  FILE_MTIME: "the file's modified time",
  UPLOAD_TIME: "when it was uploaded",
  MANUAL: "a family member",
  SIDECAR: "Google Photos",
};

/** A file whose only dates are the day it arrived is the shape of a scan: the scanner's clock, not the photograph's. */
function scanShaped(exifOriginal: string | null, filename: Date | null, source: string | null): boolean {
  return !exifOriginal && !filename && (source === "FILE_MTIME" || source === "UPLOAD_TIME" || source === "EXIF_CREATED" || source === null);
}

export async function dateReport(photoId: string): Promise<DateReport | null> {
  const photo = await db.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true, originalName: true, originalPath: true, takenAt: true, takenAtSource: true, tzOffsetMin: true, createdAt: true,
      estimatedDate: true, estimatedDateNote: true, estimatedDateConfidence: true,
      exif: true, trip: { select: { title: true, timezone: true, startDate: true, endDate: true } },
      dateSetBy: { select: { name: true, email: true } },
    },
  });
  if (!photo) return null;

  const local = storage().localPath?.(photo.originalPath);
  const exif = local ? await readExif(local).catch(() => null) : null;
  // A camera's or a name's wall time is read exactly as processing reads it: never as though it were UTC.
  const zone = photo.trip?.timezone ?? null;
  const camera = exif ? resolveTakenAt(exif, zone) : null;
  const digitized = exif ? resolveDigitizedTakenAt(exif, zone) : null;
  const named = resolveFilenameTakenAt(photo.originalName, zone);
  const fromName = named?.takenAt ?? null;
  const mtime = (photo.exif as { fileLastModified?: number } | null)?.fileLastModified ?? null;
  const guess = await guessDateFromTrip(photoId);
  const source = photo.takenAtSource;

  const witnesses: Omit<DateWitness, "shownOffsetMin">[] = [
    {
      key: "exif",
      label: "The camera (EXIF DateTimeOriginal)",
      at: camera?.takenAt ?? null,
      tzOffsetMin: camera?.tzOffsetMin ?? null,
      note: exif?.dateTimeOriginal ? "When the shutter fired. The most trustworthy thing a file carries." : "This file carries no capture time — usual for a scan, or for anything re-encoded on its way here.",
      current: source === "EXIF_OFFSET" || source === "EXIF_TZLOOKUP" || source === "TRIP_TZ",
      usable: Boolean(camera),
    },
    {
      key: "digitized",
      label: "The file's created-date tag (DateTimeDigitized)",
      at: digitized?.takenAt ?? null,
      tzOffsetMin: digitized?.tzOffsetMin ?? null,
      note: "A camera writes the capture time here too, but a scanner writes the day it scanned, and an editor the day it exported. Worth seeing, never worth trusting on its own.",
      current: source === "EXIF_CREATED",
      usable: Boolean(digitized),
    },
    {
      key: "filename",
      label: "The file name",
      at: fromName,
      tzOffsetMin: named?.tzOffsetMin ?? null,
      note: fromName ? `“${photo.originalName}” carries a date, which phones write at the moment of capture.` : "Nothing in the name looks like a date.",
      current: source === "FILE_NAME",
      usable: Boolean(fromName),
    },
    {
      key: "mtime",
      label: "The file's modified time",
      at: mtime ? new Date(mtime) : null,
      tzOffsetMin: null,
      note: "When the file was last written — for a scan that is when it was scanned, and for anything copied about, when it was copied.",
      current: source === "FILE_MTIME",
      usable: Boolean(mtime),
    },
    {
      key: "neighbors",
      label: "The other photos on this trip",
      at: guess?.takenAt ?? null,
      tzOffsetMin: guess?.tzOffsetMin ?? null,
      note: guess ? `Worked out from ${guess.evidence}.` : photo.trip ? "Nothing else on this trip says anything about this one." : "This item is on no trip, so there are no neighbors to ask.",
      current: false,
      usable: Boolean(guess),
    },
    {
      key: "model",
      label: "The AI helper's estimate",
      at: photo.estimatedDate,
      tzOffsetMin: null,
      note: photo.estimatedDateNote ? `From the picture itself: ${photo.estimatedDateNote}.` : "The helper has not estimated a year for this item.",
      current: false,
      usable: Boolean(photo.estimatedDate),
    },
    {
      key: "upload",
      label: "When it was uploaded",
      at: photo.createdAt,
      tzOffsetMin: null,
      note: "The last resort, and never evidence about the photograph itself.",
      current: source === "UPLOAD_TIME",
      usable: true,
    },
  ];

  // Shown on the one rule for a photograph's clock, so an item with no offset of its own on a trip reads in the
  // trip's zone here as it does everywhere else, rather than in UTC.
  const shown = (at: Date | null, own: number | null) => (at ? own ?? photoOffsetMin(at, photo.tzOffsetMin, zone) : null);
  return {
    photoId: photo.id,
    current: {
      at: photo.takenAt,
      source: source ? LABEL[source] ?? source : null,
      tzOffsetMin: photo.tzOffsetMin,
      shownOffsetMin: shown(photo.takenAt, null),
      setBy: photo.dateSetBy ? photo.dateSetBy.name ?? photo.dateSetBy.email.split("@")[0] : null,
    },
    weak: isWeakDate(source, photo.takenAt),
    witnesses: witnesses.map((w) => ({ ...w, shownOffsetMin: shown(w.at, w.tzOffsetMin) })),
    looksScanned: scanShaped(exif?.dateTimeOriginal ?? null, fromName, source),
  };
}
