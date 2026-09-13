/** "original" is the file as it was uploaded; "edited" is the full-size picture with any darkroom edits on it. */
export type PhotoSize = "thumb" | "medium" | "pano" | "original" | "edited" | "source" | "video" | "poster" | "model";

/** Versioned URL so caches drop stale copies after edits or visibility changes. */
export function photoUrl(photo: { id: string; updatedAt: Date | string }, size: PhotoSize): string {
  const v = typeof photo.updatedAt === "string" ? Date.parse(photo.updatedAt) : photo.updatedAt.getTime();
  return `/api/photos/${photo.id}/${size}?v=${v}`;
}
