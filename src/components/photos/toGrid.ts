import type { PhotoCard } from "@/lib/photos/queries";
import { photoUrl } from "@/lib/photos/urls";
import type { GridPhoto } from "./PhotoGrid";

/** Uploader names are part of the members-only layer: pass `member` only for signed-in viewers. */
export function uploaderLabel(name: string | null | undefined): string {
  return name?.trim() || "a family member";
}

export function toGridPhoto(p: PhotoCard, badge?: string | null, member = false): GridPhoto {
  return {
    uploadedBy: member ? uploaderLabel(p.uploader?.name) : null,
    id: p.id,
    status: p.status,
    thumbUrl: photoUrl(p, "thumb"),
    mediumUrl: photoUrl(p, "medium"),
    width: p.width,
    height: p.height,
    caption: p.caption,
    alt: p.caption ?? p.originalName,
    badge: badge ?? (p.gpsSource === "TRACK" ? "from track" : null),
  };
}
