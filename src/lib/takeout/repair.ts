import type { GpsSource, TakenAtSource } from "@/generated/prisma/enums";
import { captionFromTitle, type SidecarData } from "./sidecar";

/** The fields a repair looks at on a photo already in the album. */
export type RepairTarget = {
  lat: number | null;
  lng: number | null;
  gpsSource: GpsSource | null;
  takenAt: Date | null;
  takenAtSource: TakenAtSource | null;
  context: string | null;
  caption: string | null;
  sourceId: string | null;
  originalName: string;
};

export type RepairField = "place" | "date" | "notes" | "caption" | "googleId";
export type RepairPlan = { data: Record<string, unknown>; filled: RepairField[] };

/** A date the album only guessed from the file itself, so Google's own record of the capture time is better. */
const WEAK_DATE: TakenAtSource[] = ["FILE_MTIME", "UPLOAD_TIME"];
/** A position the album worked out itself, by interpolating a track or by recognising the place, so a position Google
 * actually recorded is better. No EXIF or hand-set value is touched. */
const WEAK_PLACE: GpsSource[] = ["TRACK", "ESTIMATE"];

/**
 * What a Takeout sidecar can add to a photo the album already holds. Only gaps are filled: anything a family member
 * wrote, and anything the camera itself recorded, is left exactly as it is. Returns null when there is nothing to add.
 *
 * This is what makes a second Takeout import a repair pass: photos uploaded from a phone lose their GPS to Android's
 * media-location redaction, and the export's sidecars still carry it.
 */
export function planSidecarRepair(photo: RepairTarget, meta: SidecarData | null): RepairPlan | null {
  if (!meta) return null;
  const data: Record<string, unknown> = {};
  const filled: RepairField[] = [];

  const hasPlace = photo.lat !== null && photo.lng !== null;
  const placeIsWeak = !hasPlace || photo.gpsSource === null || WEAK_PLACE.includes(photo.gpsSource);
  if (meta.lat !== null && meta.lng !== null && placeIsWeak) {
    data.lat = meta.lat;
    data.lng = meta.lng;
    data.altitude = null;
    data.gpsSource = "SIDECAR";
    filled.push("place");
  }

  const dateIsWeak = photo.takenAt === null || photo.takenAtSource === null || WEAK_DATE.includes(photo.takenAtSource);
  if (meta.takenAt && dateIsWeak) {
    data.takenAt = meta.takenAt;
    data.takenAtSource = "SIDECAR";
    filled.push("date");
  }

  if (meta.description && !photo.context?.trim()) {
    data.context = meta.description;
    data.contextUpdatedAt = new Date();
    // The notes feed the AI description and search, so let it look at this item again.
    data.annotationError = null;
    filled.push("notes");
  }

  const caption = captionFromTitle(meta.title, photo.originalName);
  if (caption && !photo.caption?.trim()) {
    data.caption = caption;
    filled.push("caption");
  }

  if (meta.googleId && !photo.sourceId) {
    data.sourceId = meta.googleId;
    filled.push("googleId");
  }

  return filled.length ? { data, filled } : null;
}

/** One line for the import report, in the words the admin page shows. */
export function describeRepair(originalName: string, filled: RepairField[]): string {
  const words: Record<RepairField, string> = { place: "place", date: "date", notes: "notes", caption: "caption", googleId: "Google id" };
  return `${originalName}: ${filled.map((f) => words[f]).join(", ")}`;
}
