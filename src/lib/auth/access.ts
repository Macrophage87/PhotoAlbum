import type { TripVisibility } from "@/generated/prisma/enums";
import { NOT_TRASHED } from "@/lib/photos/trash";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "./viewer";

export type ContainerKind = "trip" | "collection";
/** What a share cookie can be held for. An activity is shared by link or not at all, so it is not a container. */
export type ShareKind = ContainerKind | "activity";

/** The fields any container (trip or collection) needs for a visibility decision. */
export type ContainerAccessFields = { id: string; visibility: TripVisibility; shareToken: string | null };
export type TripAccessFields = ContainerAccessFields;

/** Key under which a share cookie for this container is held in `Viewer.shareTokens`. */
export function shareKey(kind: ShareKind, id: string): string {
  return `${kind}_${id}`;
}

/** Members see everything. Anonymous visitors see PUBLIC containers, and LINK containers whose share cookie they hold. */
export function canView(viewer: Viewer, kind: ContainerKind, container: ContainerAccessFields): boolean {
  if (viewer.kind === "user") return true;
  if (container.visibility === "PUBLIC") return true;
  if (container.visibility === "LINK" && container.shareToken) {
    const held = viewer.shareTokens.get(shareKey(kind, container.id));
    return Boolean(held) && held === container.shareToken;
  }
  return false;
}

export function canViewTrip(viewer: Viewer, trip: ContainerAccessFields): boolean {
  return canView(viewer, "trip", trip);
}

export function canViewCollection(viewer: Viewer, collection: ContainerAccessFields): boolean {
  return canView(viewer, "collection", collection);
}

/** What an activity's visibility turns on: a secret link, or nothing. There is no public activity. */
export type ActivityAccessFields = { id: string; shareToken: string | null };

/**
 * An activity is members-only until somebody makes a link to it, and then it is open to whoever holds that link —
 * the same bargain a trip's link makes, over a smaller thing. It is never public and never listed.
 */
export function canViewActivity(viewer: Viewer, activity: ActivityAccessFields): boolean {
  if (viewer.kind === "user") return true;
  if (!activity.shareToken) return false;
  return viewer.shareTokens.get(shareKey("activity", activity.id)) === activity.shareToken;
}

/** Everything a media item's visibility depends on: its trip (if any), the collections holding it, and its activity. */
export type MediaAccessFields = { trip: ContainerAccessFields | null; collections: ContainerAccessFields[]; /** The activity it was filed on, when one is known to the caller. */ activity?: ActivityAccessFields | null; /** Set while the item is in the trash: out of the album for everyone but a signed-in member. */ trashedAt?: Date | null };

/**
 * Media visibility is computed, never stored, and is the union of its containers: a viewer who may open the
 * item's trip or any collection holding it may see the item. Media in no container is members-only.
 *
 * An item in the trash is out of the album the moment it goes in: a share link or a public trip no longer reaches
 * it, however it was reachable before. Members keep access so it can be reviewed and restored.
 */
export function canViewMedia(viewer: Viewer, media: MediaAccessFields): boolean {
  if (viewer.kind === "user") return true;
  if (media.trashedAt) return false;
  if (media.trip && canView(viewer, "trip", media.trip)) return true;
  // A photograph filed on a shared activity is part of what that link promised, whatever the trip around it says.
  if (media.activity && canViewActivity(viewer, media.activity)) return true;
  return media.collections.some((c) => canView(viewer, "collection", c));
}

/** True when an anonymous visitor with no cookie and no share token could see this item (it sits in a PUBLIC container). */
export function isPubliclyViewable(media: MediaAccessFields): boolean {
  if (media.trashedAt) return false;
  return media.trip?.visibility === "PUBLIC" || media.collections.some((c) => c.visibility === "PUBLIC");
}

/**
 * A signed-in member. Everyone in the family may add to the album — upload, gather their own things, favourite,
 * trash something that should not be up — which is a different question from whether a particular photograph or
 * container is theirs to change. That question is `canEditMedia` / `canEditContainer` in `auth/ownership`.
 */
export function canContribute(viewer: Viewer): boolean {
  return viewer.kind === "user";
}

/** Prisma `where` clause restricting a trip or collection listing to what the viewer may see on global surfaces. */
export function visibleContainersWhere(viewer: Viewer): { visibility?: TripVisibility } {
  return viewer.kind === "user" ? {} : { visibility: "PUBLIC" };
}

export function visibleTripsWhere(viewer: Viewer): { visibility?: TripVisibility } {
  return visibleContainersWhere(viewer);
}

/**
 * The one Prisma filter for media on any surface (galleries, timeline, map, search, graph, people pages, JSON routes).
 * Anonymous visitors see items in a PUBLIC trip or a PUBLIC collection; share cookies never widen global surfaces.
 * Nobody, member or not, sees anything in the trash.
 */
export function visibleMediaWhere(viewer: Viewer): Prisma.PhotoWhereInput {
  if (viewer.kind === "user") return { ...NOT_TRASHED };
  return { ...NOT_TRASHED, OR: [{ trip: { visibility: "PUBLIC" } }, { collections: { some: { collection: { visibility: "PUBLIC" } } } }] };
}

/** Is this viewer in read-only mode? (i.e. can view but not edit) */
export function isReadOnly(viewer: Viewer): boolean {
  return !canContribute(viewer);
}
