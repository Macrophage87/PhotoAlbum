import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";

export { RELATION_LABEL, orderPair } from "./relations";

export async function linkedPhotos(photoId: string) {
  const links = await db.photoLink.findMany({
    // A link to something in the trash is not shown: the strip of related photographs is a gallery like any other.
    where: { OR: [{ photoAId: photoId, photoB: NOT_TRASHED }, { photoBId: photoId, photoA: NOT_TRASHED }] },
    include: {
      photoA: { select: { id: true, caption: true, originalName: true, updatedAt: true, status: true, width: true, height: true } },
      photoB: { select: { id: true, caption: true, originalName: true, updatedAt: true, status: true, width: true, height: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return links.map((l) => ({ linkId: l.id, relation: l.relation, note: l.note, other: l.photoAId === photoId ? l.photoB : l.photoA }));
}
