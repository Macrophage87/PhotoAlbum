import { db } from "@/lib/db";

/**
 * Whether what the helper may say about these items changed after a request about them was built.
 *
 * A request carries the names that were permitted when it was built, and a batch can take hours to come back. If
 * meanwhile somebody on the photographs was forgotten (their name scrubbed from the items), untagged, renamed, or
 * withdrew their agreement to be named, the answer may name them again; storing it would undo the very thing that
 * happened in between. So such an answer is thrown away, and the item is described again with the names as they
 * are now.
 */
export async function namesChangedSince(photoIds: string[], since: Date): Promise<boolean> {
  if (!photoIds.length) return false;
  const scrubbed = await db.photo.count({ where: { id: { in: photoIds }, namesScrubbedAt: { gt: since } } });
  if (scrubbed) return true;
  // Anybody on them whose record changed since: a rename, an opt-out, a consent switch, a birthday.
  const changed = await db.person.count({
    where: {
      updatedAt: { gt: since },
      OR: [{ faces: { some: { photoId: { in: photoIds } } } }, { animals: { some: { photoId: { in: photoIds } } } }],
    },
  });
  return changed > 0;
}
