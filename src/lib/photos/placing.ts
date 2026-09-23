import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { isAdmin } from "@/lib/auth/ownership";
import type { ViewerUser } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";
import { narrowing } from "@/lib/map/geojson";
import { localDayFromOffset, localDayInZone } from "@/lib/time/local-day";
import type { GalleryFilter } from "@/lib/photos/filters";

/**
 * The photographs of one trip, laid out for putting on the map.
 *
 * Everything the member may move is here, not only what is missing: a pin in the wrong spot needs fixing as much as
 * a photograph with none. `unplaced` narrows it to the ones with no position, or only a guessed one, which is what
 * somebody sitting down to "do the map" wants first.
 *
 * A member is shown their own; an admin, everyone's. The map only moves what the member may edit, so offering the
 * rest would only offer taps that do nothing.
 */

/** As many as one selection can move at once. A trip with more is narrowed with the search, or done a day at a time. */
export const PLACING_LIMIT = 500;

export type PlacingShow = "unplaced" | "all";

/** Where a position came from, as the list shows it. */
export type PlacedBy = "none" | "guess" | "camera" | "track" | "hand";

export type PlacingPhoto = {
  id: string;
  thumbUrl: string;
  label: string;
  takenAt: string | null;
  /** The local day it was taken, for grouping the list the way the timeline does. */
  day: string | null;
  lat: number | null;
  lng: number | null;
  by: PlacedBy;
  /** What the helper guessed the place was called, while the position is still its guess. */
  guess: string | null;
};

export function parsePlacingShow(v: string | string[] | undefined): PlacingShow {
  return v === "all" ? "all" : "unplaced";
}

function placedBy(lat: number | null, gpsSource: string | null): PlacedBy {
  if (lat === null) return "none";
  if (gpsSource === "ESTIMATE") return "guess";
  if (gpsSource === "TRACK") return "track";
  if (gpsSource === "MANUAL") return "hand";
  return "camera";
}

export async function photosForPlacing(
  user: ViewerUser,
  trip: { id: string; timezone: string },
  filter: GalleryFilter,
  show: PlacingShow,
): Promise<{ photos: PlacingPhoto[]; total: number }> {
  const narrowed = await narrowing(filter, trip.id);
  if (narrowed.nothing) return { photos: [], total: 0 };
  const where: Prisma.PhotoWhereInput = {
    ...NOT_TRASHED,
    status: "READY",
    kind: { in: ["PHOTO", "VIDEO"] },
    tripId: trip.id,
    ...(isAdmin(user) ? {} : { uploaderId: user.id }),
    ...narrowed.where,
    ...(show === "unplaced" ? { OR: [{ lat: null }, { gpsSource: "ESTIMATE" as const }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      take: PLACING_LIMIT,
      select: { id: true, updatedAt: true, caption: true, title: true, originalName: true, takenAt: true, tzOffsetMin: true, lat: true, lng: true, gpsSource: true, placeEstimateName: true },
    }),
    db.photo.count({ where }),
  ]);
  return {
    total,
    photos: rows.map((p) => {
      const by = placedBy(p.lat, p.gpsSource);
      return {
        id: p.id,
        thumbUrl: photoUrl(p, "thumb"),
        label: p.caption ?? p.title ?? p.originalName,
        takenAt: p.takenAt?.toISOString() ?? null,
        day: p.takenAt ? (p.tzOffsetMin !== null ? localDayFromOffset(p.takenAt, p.tzOffsetMin) : localDayInZone(p.takenAt, trip.timezone)) : null,
        lat: p.lat,
        lng: p.lng,
        by,
        guess: by === "guess" ? (p.placeEstimateName ?? null) : null,
      };
    }),
  };
}
