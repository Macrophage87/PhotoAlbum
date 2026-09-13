import { db } from "@/lib/db";
import { favouriteOrderSql } from "@/lib/favourites/queries";
import { Prisma } from "@/generated/prisma/client";
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
  const where = { ...visibleContainersWhere(viewer), ...(opts.q ? { title: { contains: opts.q, mode: "insensitive" as const } } : {}) };
  // Same order as the trips: mine, then the family's, then most recently touched.
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "Collection" c
    WHERE ${viewer.kind === "user" ? Prisma.sql`TRUE` : Prisma.sql`c.visibility = 'PUBLIC'`}
      AND ${opts.q ? Prisma.sql`c.title ILIKE ${"%" + opts.q + "%"}` : Prisma.sql`TRUE`}
    ${favouriteOrderSql("collection", "c", viewer.kind === "user" ? viewer.user.id : null, Prisma.sql`c."updatedAt" DESC, c.id DESC`)}
    LIMIT ${opts.take ?? 1000} OFFSET ${opts.skip ?? 0}`;
  const rows = await db.collection.findMany({ where: { ...where, id: { in: ids.map((i) => i.id) } }, select: collectionCardSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i.id)).filter((r): r is CollectionCardData => Boolean(r));
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
export async function collectionCoverFor(collection: { id: string; coverPhoto: { id: string; updatedAt: Date; width?: number | null; height?: number | null } | null }) {
  if (collection.coverPhoto) return collection.coverPhoto;
  const item = await db.collectionItem.findFirst({
    where: { collectionId: collection.id, photo: { status: "READY" } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { photo: { select: { id: true, updatedAt: true, width: true, height: true } } },
  });
  return item?.photo ?? null;
}

export type CollectionItemCard = PhotoCard & { itemId: string; position: number };

/** Items in display order. Every status is included so members see processing tiles. */
export async function listCollectionItems(collectionId: string, opts: { viewerId?: string | null; order?: "favourites" | "arranged" } = {}): Promise<CollectionItemCard[]> {
  const items = await db.collectionItem.findMany({
    where: { collectionId, photo: NOT_TRASHED },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true, photo: { select: photoCardSelect } },
  });
  const cards = items.map((i) => ({ ...i.photo, itemId: i.id, position: i.position }));
  // An empty collection has nothing to order, and asking Postgres about an empty list is an error, not a no-op.
  if (!cards.length || (opts.order ?? "favourites") !== "favourites") return cards;
  // Favourites lead; the collection's own arrangement is the tie-break, so everything else stays where it was put.
  const state = await db.$queryRaw<{ id: string; n: bigint; mine: boolean }[]>`
    SELECT p.id,
           (SELECT count(*) FROM "PhotoFavorite" f WHERE f."photoId" = p.id) AS n,
           ${opts.viewerId ? Prisma.sql`EXISTS (SELECT 1 FROM "PhotoFavorite" m WHERE m."photoId" = p.id AND m."userId" = ${opts.viewerId})` : Prisma.sql`FALSE`} AS mine
    FROM "Photo" p WHERE p.id IN (${Prisma.join(cards.map((c) => c.id))})`;
  const by = new Map(state.map((s) => [s.id, { n: Number(s.n), mine: s.mine }]));
  return cards
    .map((c, i) => ({ c, i, f: by.get(c.id) ?? { n: 0, mine: false } }))
    .sort((a, b) => Number(b.f.mine) - Number(a.f.mine) || b.f.n - a.f.n || a.i - b.i)
    .map((x) => x.c);
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
