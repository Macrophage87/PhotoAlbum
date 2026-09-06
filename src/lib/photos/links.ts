import { db } from "@/lib/db";

export { RELATION_LABEL, orderPair } from "./relations";

export async function linkedPhotos(photoId: string) {
  const links = await db.photoLink.findMany({
    where: { OR: [{ photoAId: photoId }, { photoBId: photoId }] },
    include: {
      photoA: { select: { id: true, caption: true, originalName: true, updatedAt: true, status: true, width: true, height: true } },
      photoB: { select: { id: true, caption: true, originalName: true, updatedAt: true, status: true, width: true, height: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return links.map((l) => ({ linkId: l.id, relation: l.relation, note: l.note, other: l.photoAId === photoId ? l.photoB : l.photoA }));
}
