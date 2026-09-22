/**
 * What a run of batch auto colour did, and how it is said out loud. Both the trip's own gallery and the album-wide
 * selection bar offer the same press, so they report it in the same words.
 */
export type AutoColourResult = {
  /** The photographs the run put auto levels on, so the whole batch can be handed back in one press. */
  changed: string[];
  already: number;
  notPhotos: number;
  notYours: number;
};

export function describeAutoColour(r: AutoColourResult): string {
  const parts = [`${r.changed.length} corrected`];
  if (r.already) parts.push(`${r.already} already were`);
  if (r.notPhotos) parts.push(`${r.notPhotos} are not photographs`);
  if (r.notYours) parts.push(`${r.notYours} not yours to change`);
  return `Auto color: ${parts.join(", ")}. The originals are untouched.`;
}

export function describeUndoColour(n: number): string {
  return `${n} put back as ${n === 1 ? "it was" : "they were"}.`;
}
