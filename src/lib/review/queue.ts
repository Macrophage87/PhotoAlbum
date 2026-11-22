import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { editableMediaWhere } from "@/lib/auth/ownership";
import { cursorWhere, encodeCursor, type KeyColumn } from "@/lib/photos/keyset";
import type { ViewerUser } from "@/lib/auth/viewer";

/**
 * How many unreviewed items the review screen opens with. A Takeout import of a decade used to put every one of them,
 * with its suggestions and proposals, on the one page (#12); the rest now come a page at a time.
 */
export const REVIEW_PAGE = 120;

const ORDER: KeyColumn[] = [{ field: "createdAt", dir: "desc" }];

/** What a member works through: their own uploads nobody has reviewed (everyone's, for an admin). */
export function unreviewedWhere(user: Pick<ViewerUser, "id" | "role">): Prisma.PhotoWhereInput {
  return { reviewedAt: null, ...NOT_TRASHED, ...editableMediaWhere(user) };
}

/**
 * One page of the Unreviewed queue, newest upload first, with a cursor for the next. `ids` re-reads items the page
 * already shows (after an action changed them); any no longer unreviewed are left out.
 */
export async function unreviewedPage<S extends Prisma.PhotoSelect>(user: Pick<ViewerUser, "id" | "role">, select: S, opts: { cursor?: string | null; take?: number; ids?: string[] } = {}) {
  const take = opts.take ?? REVIEW_PAGE;
  const where: Prisma.PhotoWhereInput = { ...unreviewedWhere(user), ...(opts.ids ? { id: { in: opts.ids } } : {}) };
  const rows = (await db.photo.findMany({ where: { AND: [where, await cursorWhere(opts.cursor, ORDER, where)] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { ...select, id: true, createdAt: true } as Prisma.PhotoSelect, take: take + 1 })) as unknown as (Prisma.PhotoGetPayload<{ select: S }> & { id: string; createdAt: Date })[];
  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  return { photos: page, nextCursor: more ? encodeCursor(page[page.length - 1], ORDER) : null };
}
