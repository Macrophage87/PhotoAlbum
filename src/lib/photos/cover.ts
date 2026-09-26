/**
 * A photograph in the trash is not a cover.
 *
 * Covers are chosen by hand and then remembered, which means a trip or a collection goes on leading with a
 * photograph long after somebody decided it should not be in the album — on its card on the front page, and in the
 * picture Facebook draws when the link is shared. Rather than reaching into every trip and collection when
 * something is trashed, the question is asked where the cover is read: a trashed one simply does not count, and
 * the album falls back to choosing one itself. Restoring the photograph makes it the cover again, as it was.
 */
export function coverUnlessTrashed<T extends { trashedAt?: Date | null }>(cover: T | null | undefined): T | null {
  return cover && !cover.trashedAt ? cover : null;
}

/**
 * What every trip and collection reads of its hand-chosen cover: enough to draw it and put it on a link preview, and
 * enough to tell whether it still stands.
 */
export const coverPhotoSelect = { select: { id: true, updatedAt: true, width: true, height: true, trashedAt: true, status: true, tripId: true } } as const;

/**
 * A hand-chosen cover, while it is still one to lead with: out of the trash, and finished. A photograph still being
 * processed, or whose processing failed, has no pictures to draw, and a cover pointing at one is a broken image on
 * the front page and on every link preview. `status` is required so a caller cannot forget to select it.
 */
export function standingCover<T extends { trashedAt?: Date | null; status: string }>(cover: T | null | undefined): T | null {
  const kept = coverUnlessTrashed(cover);
  return kept && kept.status === "READY" ? kept : null;
}

/** What may be chosen as a cover: the same photographs the cover pages offer, finished and out of the trash. */
export const COVERABLE = { status: "READY", trashedAt: null } as const;
