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
 * The largest copy the album has of a picture: its full size, its panorama copy, or its medium. These are written
 * by sharp without the file's metadata, so none carries EXIF or GPS: what anybody outside the family is given in
 * place of the file as uploaded when there is no full-size copy to give them. Null until the item has been processed.
 */
export function largestRendition(r: Renditions | null | undefined): { size: "edited" | "pano" | "medium"; rendition: Rendition } | null {
  if (r?.full) return { size: "edited", rendition: r.full };
  if (r?.pano) return { size: "pano", rendition: r.pano };
  return r?.medium ? { size: "medium", rendition: r.medium } : null;
}

/**
 * Where "open the full-size photo" goes. A member gets the picture as it is now, which for an item nobody has edited
 * is its own file; anybody else gets the same picture at the same size, as a copy with none of the file's metadata
 * that the album makes for them (see `lib/images/visitor-copy`). Nothing until the item has been processed.
 *
 * `view=share` is on the address so it is answered as anybody's would be even for a member previewing a share page,
 * whose cookie would otherwise fetch the file as uploaded from the very link visitors are given.
 */
export function fullSizeUrl(photo: { id: string; imageVersion: number; edits: unknown; renditions: unknown }, member: boolean): string | null {
  if (member) return photoUrl(photo, photo.edits ? "edited" : "original");
  return photo.renditions ? `${photoUrl(photo, "edited")}&view=share` : null;
}
