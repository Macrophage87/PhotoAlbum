/**
 * Which words on a photograph, trip, collection or activity are the helper's rather than a member's. Pure.
 *
 * Forgetting somebody rewrites the helper's words and never a member's, and the helper is never handed its own old
 * words back as if the family had written them. A title counts as the helper's while it is the one the helper gave
 * (it only ever fills an empty title, and a member who types a different one makes it theirs); a description counts
 * as the helper's while it is the text the helper wrote, and saving different words by hand makes it the member's.
 */

/** The helper's title for an item, from its record. */
export function helperTitle(annotation: unknown): string | null {
  const t = annotation && typeof annotation === "object" ? (annotation as { title?: unknown }).title : null;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/**
 * Whether a title of the item (its own, or `membersTitle`) is the helper's: the one its record gives now, or, with
 * `byHelper` (Photo.titleByHelper), one it gave before and nobody has changed since.
 */
export function isHelperTitle(title: string | null | undefined, annotation: unknown, byHelper = false): boolean {
  if (typeof title !== "string" || !title.trim()) return false;
  return byHelper || title.trim() === helperTitle(annotation);
}

/** The title a member gave the item, if any: what may be handed to the helper as the family's own words. */
export function memberTitle(title: string | null | undefined, annotation: unknown, byHelper = false): string | null {
  return title?.trim() && !isHelperTitle(title, annotation, byHelper) ? title : null;
}

/**
 * Whether a description is still the helper's after a save by hand. Saving the same words again (the box the
 * helper's answer lands in is saved as it stands) keeps it the helper's; anything else is the member's.
 */
export function descriptionStaysHelpers(before: { description: string | null; descriptionByHelper: boolean }, next: string | null | undefined): boolean {
  return before.descriptionByHelper && (next ?? "").trim() === (before.description ?? "").trim() && Boolean(next?.trim());
}
