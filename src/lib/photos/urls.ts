import type { Rendition, Renditions } from "@/lib/images/renditions";

/**
 * "original" is the file as it was uploaded; "edited" is the full-size picture with any darkroom edits on it;
 * "preview" is the medium copy as JPEG, which only link previews ask for.
 */
export type PhotoSize = "thumb" | "medium" | "pano" | "preview" | "original" | "edited" | "source" | "video" | "poster" | "model";

/**
 * Versioned URL so caches drop stale copies after edits or visibility changes. By `imageVersion`, never `updatedAt`:
 * a text-only write (a caption, the helper's words, a forget's rewrite) must not change what strangers can see.
 */
export function photoUrl(photo: { id: string; imageVersion: number }, size: PhotoSize): string {
  return `/api/photos/${photo.id}/${size}?v=${photo.imageVersion}`;
}

/**
 * The largest copy the album made of a picture: its edited full size, its panorama copy, or its medium. These are
 * written by sharp without the file's metadata, so none carries EXIF or GPS; this is the full-size view for anybody
 * outside the family, who never gets the file as uploaded. Null until the item has been processed.
 */
export function largestRendition(r: Renditions | null | undefined): { size: "edited" | "pano" | "medium"; rendition: Rendition } | null {
  if (r?.full) return { size: "edited", rendition: r.full };
  if (r?.pano) return { size: "pano", rendition: r.pano };
  return r?.medium ? { size: "medium", rendition: r.medium } : null;
}

/**
 * Where "open the full-size photo" goes. A member gets the picture as it is now, which for an item nobody has edited
 * is its own file; anybody else gets the largest rendition, and nothing when that is the medium already on screen.
 */
export function fullSizeUrl(photo: { id: string; imageVersion: number; edits: unknown; renditions: unknown }, member: boolean): string | null {
  if (member) return photoUrl(photo, photo.edits ? "edited" : "original");
  const largest = largestRendition(photo.renditions as Renditions | null);
  return largest && largest.size !== "medium" ? photoUrl(photo, largest.size) : null;
}
