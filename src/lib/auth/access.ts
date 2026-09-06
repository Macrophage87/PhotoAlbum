import type { TripVisibility } from "@/generated/prisma/enums";
import type { Viewer } from "./viewer";

export type TripAccessFields = { id: string; visibility: TripVisibility; shareToken: string | null };

/** Members see everything. Anonymous visitors see PUBLIC trips, and LINK trips whose share cookie they hold. */
export function canViewTrip(viewer: Viewer, trip: TripAccessFields): boolean {
  if (viewer.kind === "user") return true;
  if (trip.visibility === "PUBLIC") return true;
  if (trip.visibility === "LINK" && trip.shareToken) {
    const held = viewer.shareTokens.get(trip.id);
    return Boolean(held) && held === trip.shareToken;
  }
  return false;
}

export function canEditTrip(viewer: Viewer): boolean {
  return viewer.kind === "user";
}

/** Prisma `where` clause restricting a trip query to what the viewer may see. */
export function visibleTripsWhere(viewer: Viewer): { visibility?: TripVisibility } {
  return viewer.kind === "user" ? {} : { visibility: "PUBLIC" };
}

/** Is this viewer in read-only mode for the given trip? (i.e. can view but not edit) */
export function isReadOnly(viewer: Viewer): boolean {
  return !canEditTrip(viewer);
}
