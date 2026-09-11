import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewMedia, isPubliclyViewable, type ContainerKind, type MediaAccessFields } from "@/lib/auth/access";

export const mediaAccessInclude = {
  trip: { select: { id: true, visibility: true, shareToken: true } },
  collections: { select: { collection: { select: { id: true, visibility: true, shareToken: true } } } },
} as const;

type Loaded = { trip: { id: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null } | null; collections: { collection: { id: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null } }[] };

export function toMediaAccess(photo: Loaded): MediaAccessFields {
  return { trip: photo.trip, collections: photo.collections.map((c) => c.collection) };
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

/** Load one photo with the containers its visibility depends on, or null. */
export async function loadViewablePhoto(viewer: Viewer, id: string) {
  const photo = await db.photo.findUnique({ where: { id }, include: mediaAccessInclude });
  if (!photo || !canViewMedia(viewer, toMediaAccess(photo))) return null;
  return photo;
}
