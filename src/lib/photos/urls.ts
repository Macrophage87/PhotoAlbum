export type PhotoSize = "thumb" | "medium" | "original" | "video" | "poster";

/** Versioned URL so caches drop stale copies after edits or visibility changes. */
export function photoUrl(photo: { id: string; updatedAt: Date | string }, size: PhotoSize): string {
  const v = typeof photo.updatedAt === "string" ? Date.parse(photo.updatedAt) : photo.updatedAt.getTime();
  return `/api/photos/${photo.id}/${size}?v=${v}`;
}
