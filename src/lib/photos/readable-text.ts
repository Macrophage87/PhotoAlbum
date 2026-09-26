/**
 * What of a photograph's words this viewer may read.
 *
 * Members read everything. Anybody else — a public trip's visitor, a share link's holder — reads the family's own
 * caption and title, and the helper's description only where it was written from nothing members-only: never the
 * uploader's notes, and never the helper's text or title where it came from names or notes (`annotationMembersOnly`).
 * Search keeps the same split in its two columns and its snippet (`hitTextSql`), so the words that can be matched
 * are the words that can be read.
 */
export type TextFields = { title: string | null; membersTitle?: string | null; caption: string | null; context?: string | null; annotation?: unknown; annotationMembersOnly?: boolean };

/** The title an item goes by: its own, else, for members, the one the helper wrote that names somebody. */
export function readableTitle(p: Pick<TextFields, "title" | "membersTitle">, member: boolean): string | null {
  const own = p.title?.trim() ? p.title : null;
  return own ?? (member ? p.membersTitle?.trim() || null : null);
}

/** What the helper's guess at the place is called, and why, for this viewer: see `placeFromMembersOnly`. */
export function readablePlaceGuess(p: { placeEstimateName: string | null; placeEstimateNote: string | null; placeEstimateMembersOnly?: boolean }, member: boolean): { name: string | null; note: string | null } {
  if (member || p.placeEstimateMembersOnly === false) return { name: p.placeEstimateName, note: p.placeEstimateNote };
  return { name: null, note: null };
}

/** The lightbox's description: the helper's, else the notes (members only). */
export function readableDescription(p: TextFields, member: boolean): string | null {
  const ai = (p.annotation as { description?: string } | null)?.description ?? null;
  if (member) return ai ?? p.context ?? null;
  // A caller that did not ask whether it is members-only gets the answer that cannot leak.
  return p.annotationMembersOnly === false ? ai : null;
}

/**
 * A trip's, a collection's or an activity's description for this viewer: the same rule, for text the helper can
 * write about a whole trip at once (`descriptionMembersOnly`).
 */
export function readableContainerDescription(c: { description: string | null; descriptionMembersOnly: boolean }, member: boolean): string | null {
  return member || !c.descriptionMembersOnly ? c.description : null;
}

/** The same thing with its description replaced by what this viewer may read, for handing on to a page. */
export function withReadableDescription<T extends { description: string | null; descriptionMembersOnly: boolean }>(c: T, member: boolean): T {
  return { ...c, description: readableContainerDescription(c, member) };
}
