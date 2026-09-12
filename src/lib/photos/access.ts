import type { Viewer } from "@/lib/auth/viewer";
import { canViewMedia, isPubliclyViewable, type ContainerKind, type MediaAccessFields } from "@/lib/auth/access";

/** The fields a media route selects to decide whether it may answer at all: where the item lives, and whether it is
 * in the trash. Spread into a `select`, never an `include`: `trashedAt` is a column, not a relation. */
export const mediaAccessInclude = {
  trashedAt: true,
  trip: { select: { id: true, visibility: true, shareToken: true } },
  collections: { select: { collection: { select: { id: true, visibility: true, shareToken: true } } } },
} as const;

type Loaded = { trashedAt?: Date | null; trip: { id: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null } | null; collections: { collection: { id: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null } }[] };

export function toMediaAccess(photo: Loaded): MediaAccessFields {
  return { trashedAt: photo.trashedAt ?? null, trip: photo.trip, collections: photo.collections.map((c) => c.collection) };
}

/**
 * Decide whether a media item's bytes may be served. A `?share=<token>&kind=trip|collection` pair stands in for the
 * share cookie (link previews fetch without cookies) and is honoured only when it matches a LINK container that
 * actually holds the item.
 */
export function mediaBytesAllowed(viewer: Viewer, media: MediaAccessFields, share?: { token: string | null; kind: string | null }): boolean {
  if (canViewMedia(viewer, media)) return true;
  if (!share?.token) return false;
  const kind: ContainerKind = share.kind === "collection" ? "collection" : "trip";
  const candidates = kind === "trip" ? (media.trip ? [media.trip] : []) : media.collections;
  return candidates.some((c) => c.visibility === "LINK" && c.shareToken === share.token);
}

/** Cache directive for a media response: shared caches only for items anyone on the internet could fetch anyway. */
export function mediaCacheControl(media: MediaAccessFields, versioned: boolean): string {
  if (!versioned) return "private, max-age=0, must-revalidate";
  return isPubliclyViewable(media) ? "public, max-age=31536000, immutable" : "private, max-age=86400";
}
