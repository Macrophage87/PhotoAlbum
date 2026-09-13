import type { PhotoCard } from "@/lib/photos/queries";
import { photoUrl } from "@/lib/photos/urls";
import type { GridPhoto } from "./PhotoGrid";

/**
 * Uploader names are part of the members-only layer: pass `member` only for signed-in viewers. A member who has not
 * set a name on their account page is shown by the part of their address before the @.
 */
export function uploaderLabel(name: string | null | undefined, email?: string | null): string {
  return name?.trim() || email?.split("@")[0]?.trim() || "a family member";
}

export function toGridPhoto(p: PhotoCard, badge?: string | null, member = false): GridPhoto {
  return {
    uploadedBy: member ? uploaderLabel(p.uploader?.name, p.uploader?.email) : null,
    canTag: member && p.status === "READY",
    collections: member ? p.collections.map((c) => c.collection) : [],
    youtubeId: p.kind === "EXTERNAL_VIDEO" ? p.externalId : null,
    videoUrl: p.kind === "VIDEO" && p.status === "READY" ? photoUrl(p, "video") : null,
    // The full-size view follows the picture as it is now; an item nobody has edited links straight to its own file.
    originalUrl: p.kind === "PHOTO" && p.status === "READY" ? photoUrl(p, p.edits ? "edited" : "original") : null,
    durationS: p.durationS,
    title: p.title,
    unavailable: p.externalStatus === "UNAVAILABLE",
    id: p.id,
    status: p.status,
    thumbUrl: photoUrl(p, "thumb"),
    mediumUrl: photoUrl(p, "medium"),
    width: p.width,
    height: p.height,
    caption: p.caption,
    alt: p.caption ?? p.title ?? p.originalName,
    badge: badge ?? (p.gpsSource === "TRACK" ? "from track" : null),
  };
}
