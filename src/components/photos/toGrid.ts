import type { PhotoCard } from "@/lib/photos/queries";
import type { FavouriteState } from "@/lib/favourites/queries";
import { fullSizeUrl, photoUrl } from "@/lib/photos/urls";
import type { GridPhoto } from "./PhotoGrid";
import { readableTitle } from "@/lib/photos/readable-text";

/**
 * Uploader names are part of the members-only layer: pass `member` only for signed-in viewers. A member who has not
 * set a name on their account page is shown by the part of their address before the @.
 */
export function uploaderLabel(name: string | null | undefined, email?: string | null): string {
  return name?.trim() || email?.split("@")[0]?.trim() || "a family member";
}

export function toGridPhoto(p: PhotoCard, badge?: string | null, member = false, favourite?: FavouriteState | null): GridPhoto {
  // The helper's title that names somebody is a member's to read; anybody else sees the item's own title or none.
  const title = readableTitle(p, member);
  return {
    uploadedBy: member ? uploaderLabel(p.uploader?.name, p.uploader?.email) : null,
    canTag: member && p.status === "READY",
    collections: member ? p.collections.map((c) => c.collection) : [],
    youtubeId: p.kind === "EXTERNAL_VIDEO" ? p.externalId : null,
    videoUrl: p.kind === "VIDEO" && p.status === "READY" ? photoUrl(p, "video") : null,
    // A scan has no picture of its own until somebody has opened it once: until then the tile says what it is.
    scan: p.kind === "SCAN" ? { format: p.scanFormat, modelUrl: photoUrl(p, "model"), hasPoster: Boolean(p.renditions) } : null,
    // The full-size view follows the picture as it is now; only a member is linked to the file as uploaded.
    originalUrl: p.kind === "PHOTO" && p.status === "READY" ? fullSizeUrl(p, member) : null,
    durationS: p.durationS,
    title,
    unavailable: p.externalStatus === "UNAVAILABLE",
    id: p.id,
    status: p.status,
    thumbUrl: photoUrl(p, "thumb"),
    mediumUrl: photoUrl(p, "medium"),
    width: p.width,
    height: p.height,
    // A panorama carries the long rendition it is panned across, so a tile and the lightbox can both show it whole.
    panorama: p.panorama ? { projection: p.panoProjection, panoUrl: photoUrl(p, "pano") } : null,
    caption: p.caption,
    alt: p.caption ?? title ?? p.originalName,
    badge: badge ?? (p.gpsSource === "TRACK" ? "from track" : null),
    takenAt: p.takenAt?.toISOString() ?? null,
    tzOffsetMin: p.tzOffsetMin,
    placeName: p.placeName,
    favourite: member ? favourite ?? null : null,
  };
}
