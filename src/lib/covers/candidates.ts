import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";

/**
 * The photographs a trip or a collection can be fronted by.
 *
 * Only finished ones: a cover is the picture the album leads with, and half a processing job is not that. They come
 * in the order the thing itself is read in — a trip by when its photographs were taken, a collection in the order
 * somebody arranged it — because a cover is usually near the front of what the family already thinks of as the
 * beginning.
 */

/** A page of candidates. Kept small on purpose: this is a page of choices, not a gallery. */
export const COVER_PAGE = 60;

export type CoverCandidate = { id: string; updatedAt: Date; caption: string | null; title: string | null; originalName: string };

const select = { id: true, updatedAt: true, caption: true, title: true, originalName: true } as const;

export async function tripCoverCandidates(tripId: string, cursor?: string | null, take = COVER_PAGE): Promise<{ photos: CoverCandidate[]; nextCursor: string | null; total: number }> {
  const where = { tripId, status: "READY" as const, ...NOT_TRASHED };
  const [rows, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      select,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    db.photo.count({ where }),
  ]);
  const more = rows.length > take;
  const photos = more ? rows.slice(0, take) : rows;
  return { photos, nextCursor: more ? photos[photos.length - 1].id : null, total };
}

export async function collectionCoverCandidates(collectionId: string, cursor?: string | null, take = COVER_PAGE): Promise<{ photos: CoverCandidate[]; nextCursor: string | null; total: number }> {
  const where = { collectionId, photo: { status: "READY" as const, ...NOT_TRASHED } };
  const [rows, total] = await Promise.all([
    db.collectionItem.findMany({
      where,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, photo: { select } },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    db.collectionItem.count({ where }),
  ]);
  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  // The cursor is the membership row's id, since that is what the order is keyed on.
  return { photos: page.map((r) => r.photo), nextCursor: more ? page[page.length - 1].id : null, total };
}
