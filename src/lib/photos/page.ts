import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { photoCardSelect, type PhotoCard } from "./queries";

/** Gallery pages load this many items at a time; the client asks for the next page by cursor. */
export const GALLERY_PAGE = 240;

export type PhotoPage = { photos: PhotoCard[]; nextCursor: string | null; total: number };

/** One page of a trip's gallery in capture order, with a cursor (the last item's id) for the next page. */
export async function tripPhotoPage(tripId: string, opts: { uploaderId?: string; cursor?: string | null; take?: number } = {}): Promise<PhotoPage> {
  const take = opts.take ?? GALLERY_PAGE;
  const where: Prisma.PhotoWhereInput = { tripId, ...(opts.uploaderId ? { uploaderId: opts.uploaderId } : {}), status: { in: ["READY", "PENDING", "PROCESSING", "FAILED"] } };
  const [photos, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      select: photoCardSelect,
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    db.photo.count({ where }),
  ]);
  const more = photos.length > take;
  const page = more ? photos.slice(0, take) : photos;
  return { photos: page, nextCursor: more ? page[page.length - 1].id : null, total };
}

export type CandidateFilter = { excludeCollectionId: string; trip?: string | null; q?: string | null };

/**
 * Ready items not yet in a collection, newest first, for the "add existing photos" picker. `trip` is a trip id or
 * "none" for items without a trip; `q` matches the caption, title, notes or file name.
 */
export async function candidatePhotoPage(filter: CandidateFilter, opts: { cursor?: string | null; take?: number } = {}): Promise<PhotoPage> {
  const take = opts.take ?? GALLERY_PAGE;
  const q = filter.q?.trim();
  const where: Prisma.PhotoWhereInput = {
    status: "READY",
    collections: { none: { collectionId: filter.excludeCollectionId } },
    ...(filter.trip === "none" ? { tripId: null } : filter.trip ? { tripId: filter.trip } : {}),
    ...(q ? { OR: [{ caption: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { context: { contains: q, mode: "insensitive" } }, { originalName: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [photos, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
      select: photoCardSelect,
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    db.photo.count({ where }),
  ]);
  const more = photos.length > take;
  const page = more ? photos.slice(0, take) : photos;
  return { photos: page, nextCursor: more ? page[page.length - 1].id : null, total };
}
