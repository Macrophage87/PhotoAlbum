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
