import type { PhotoCard } from "@/lib/photos/queries";
import type { FavouriteState } from "@/lib/favourites/queries";
import { fullSizeUrl, photoUrl } from "@/lib/photos/urls";
import type { GridPhoto } from "./PhotoGrid";
import { readableTitle } from "@/lib/photos/readable-text";
import { canEditMedia } from "@/lib/auth/ownership";
import type { ViewerUser } from "@/lib/auth/viewer";
import { formatLocalTime } from "@/lib/time/format";
import { scanShareable } from "@/lib/media/mime";

/**
 * Uploader names are part of the members-only layer: pass `member` only for signed-in viewers. A member who has not
 * set a name on their account page is shown by the part of their address before the @.
 */
export function uploaderLabel(name: string | null | undefined, email?: string | null): string {
  return name?.trim() || email?.split("@")[0]?.trim() || "a family member";
}

/**
 * `member` is the signed-in member the tile is drawn for, or null for anybody else (a share page's viewer included):
 * it opens the members-only layer, and says whether tagging from the lightbox is theirs to do.
 */
const KIND_WORD: Record<string, string> = { PHOTO: "Photo", VIDEO: "Video", EXTERNAL_VIDEO: "Video", SCAN: "3D scan" };

/**
 * Alt text for an item with no caption or title, for anybody outside the family. The file's own name is the
 * family's — phones and people write names, places and dates into it — so a stranger's screen reader hears what the
 * item is and, where the album knows it, the day it was taken.
 */
export function outsiderAlt(p: { kind: string; takenAt: Date | null; tzOffsetMin: number | null }): string {
  const what = KIND_WORD[p.kind] ?? "Photo";
  return p.takenAt ? `${what} taken ${formatLocalTime(p.takenAt, { offsetMin: p.tzOffsetMin }, "MMMM d, yyyy")}` : what;
}

export function toGridPhoto(p: PhotoCard, badge?: string | null, viewer: Pick<ViewerUser, "id" | "role"> | null = null, favourite?: FavouriteState | null): GridPhoto {
  const member = viewer !== null;
  // The helper's title that names somebody is a member's to read; anybody else sees the item's own title or none.
  const title = readableTitle(p, member);
  return {
    uploadedBy: member ? uploaderLabel(p.uploader?.name, p.uploader?.email) : null,
    // Tagging (and a scan's first still) changes the item, so it is its uploader's and an admin's, as on its page.
    canTag: member && p.status === "READY" && canEditMedia(viewer, p),
    collections: member ? p.collections.map((c) => c.collection) : [],
    youtubeId: p.kind === "EXTERNAL_VIDEO" ? p.externalId : null,
    videoUrl: p.kind === "VIDEO" && p.status === "READY" ? photoUrl(p, "video") : null,
    // A scan has no picture of its own until somebody has opened it once: until then the tile says what it is.
    // Outside the family a scan is given only as a copy cleaned of its metadata, and a format that cannot be cleaned not at all.
    scan: p.kind === "SCAN" ? { format: p.scanFormat, modelUrl: photoUrl(p, "model"), hasPoster: Boolean(p.renditions), withheld: !member && !scanShareable(p.scanFormat) } : null,
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
    alt: p.caption ?? title ?? (member ? p.originalName : outsiderAlt(p)),
    badge: badge ?? (p.gpsSource === "TRACK" ? "from track" : null),
    takenAt: p.takenAt?.toISOString() ?? null,
    tzOffsetMin: p.tzOffsetMin,
    placeName: p.placeName,
    favourite: member ? favourite ?? null : null,
  };
}
