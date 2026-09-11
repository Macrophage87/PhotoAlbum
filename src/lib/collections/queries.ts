import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleContainersWhere } from "@/lib/auth/access";
import { photoCardSelect, type PhotoCard } from "@/lib/photos/queries";

export const collectionCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  themeKey: true,
  visibility: true,
  shareToken: true,
  coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } },
  _count: { select: { items: true } },
} satisfies Prisma.CollectionSelect;

export type CollectionCardData = Prisma.CollectionGetPayload<{ select: typeof collectionCardSelect }>;

/** Collections listed on global surfaces: everything for members, PUBLIC only for anonymous visitors. */
export async function listVisibleCollections(viewer: Viewer): Promise<CollectionCardData[]> {
  return db.collection.findMany({ where: visibleContainersWhere(viewer), orderBy: { updatedAt: "desc" }, select: collectionCardSelect });
}

export async function getCollectionBySlug(slug: string) {
  return db.collection.findUnique({
    where: { slug },
    include: { coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } }, _count: { select: { items: true } } },
  });
}

export type CollectionWithCounts = NonNullable<Awaited<ReturnType<typeof getCollectionBySlug>>>;

/** Cover photo, or the first ready item when no cover is set. */
export async function collectionCoverFor(collection: { id: string; coverPhoto: { id: string; updatedAt: Date } | null }) {
  if (collection.coverPhoto) return collection.coverPhoto;
  const item = await db.collectionItem.findFirst({
    where: { collectionId: collection.id, photo: { status: "READY" } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { photo: { select: { id: true, updatedAt: true } } },
  });
  return item?.photo ?? null;
}

export type CollectionItemCard = PhotoCard & { itemId: string; position: number };

/** Items in display order. Every status is included so members see processing tiles. */
export async function listCollectionItems(collectionId: string): Promise<CollectionItemCard[]> {
  const items = await db.collectionItem.findMany({
    where: { collectionId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true, photo: { select: photoCardSelect } },
  });
  return items.map((i) => ({ ...i.photo, itemId: i.id, position: i.position }));
}

/** Collections holding a photo, with membership for the picker on the photo page. */
export async function collectionsForPhoto(photoId: string) {
  const [all, mine] = await Promise.all([
    db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, slug: true, title: true, visibility: true } }),
    db.collectionItem.findMany({ where: { photoId }, select: { collectionId: true } }),
  ]);
  const held = new Set(mine.map((m) => m.collectionId));
  return all.map((c) => ({ ...c, member: held.has(c.id) }));
}
