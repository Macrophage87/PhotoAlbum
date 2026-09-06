import type { PhotoCard } from "@/lib/photos/queries";
import { photoUrl } from "@/lib/photos/urls";
import type { GridPhoto } from "./PhotoGrid";

export function toGridPhoto(p: PhotoCard, badge?: string | null): GridPhoto {
  return {
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
