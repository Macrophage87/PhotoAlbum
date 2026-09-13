import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleContainersWhere } from "@/lib/auth/access";
import { photoCardSelect, type PhotoCard } from "@/lib/photos/queries";
import { NOT_TRASHED } from "@/lib/photos/trash";

export const collectionCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  themeKey: true,
  visibility: true,
  shareToken: true,
  coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } },
  _count: { select: { items: { where: { photo: NOT_TRASHED } } } },
} satisfies Prisma.CollectionSelect;

export type CollectionCardData = Prisma.CollectionGetPayload<{ select: typeof collectionCardSelect }>;

/** Collections listed on global surfaces: everything for members, PUBLIC only for anonymous visitors. */
/** Collections for the front page, most recently touched first, optionally narrowed by name, and paged. */
export async function listVisibleCollections(viewer: Viewer, opts: { q?: string | null; take?: number; skip?: number } = {}): Promise<CollectionCardData[]> {
  return db.collection.findMany({
    where: { ...visibleContainersWhere(viewer), ...(opts.q ? { title: { contains: opts.q, mode: "insensitive" as const } } : {}) },
    orderBy: { updatedAt: "desc" },
    select: collectionCardSelect,
    ...(opts.take ? { take: opts.take } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
}

export async function countVisibleCollections(viewer: Viewer, q?: string | null): Promise<number> {
  return db.collection.count({ where: { ...visibleContainersWhere(viewer), ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}) } });
}

export async function getCollectionBySlug(slug: string) {
  return db.collection.findUnique({
    where: { slug },
    include: { coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } }, _count: { select: { items: { where: { photo: NOT_TRASHED } } } } },
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
/**
 * The collections an item is in. Deliberately not every collection there is: the edit form searches for the others,
 * because a family that has been at this a while has far more of them than a list on a form should ever hold.
 */
export async function collectionsForPhoto(photoId: string) {
  const mine = await db.collectionItem.findMany({
    where: { photoId },
    orderBy: { collection: { title: "asc" } },
    select: { collection: { select: { id: true, slug: true, title: true, visibility: true } } },
  });
  return mine.map((m) => m.collection);
}
