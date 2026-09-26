import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { GALLERY_PAGE, idsInLocalYear, idsMatching, intersectIds } from "./page";
import { NO_FILTER, type GalleryFilter } from "./filters";
import { idsWithPerson } from "@/lib/people/in-photos";
import { cursorWhere, encodeCursor, type KeyColumn } from "./keyset";

export const photoCardSelect = {
  id: true,
  tripId: true,
  activityId: true,
  status: true,
  width: true,
  height: true,
  panorama: true,
  panoProjection: true,
  takenAt: true,
  tzOffsetMin: true,
  lat: true,
  lng: true,
  gpsSource: true,
  placeName: true,
  caption: true,
  originalName: true,
  updatedAt: true,
  uploader: { select: { name: true, email: true } },
  collections: { select: { collection: { select: { slug: true, title: true } } } },
  kind: true,
  scanFormat: true,
  /** Only to know whether a scan has had its still taken yet; the contents are never rendered from a card. */
  renditions: true,
  externalId: true,
  title: true,
  /** Read through `readableTitle`: members only. */
  membersTitle: true,
  durationS: true,
  externalStatus: true,
  /** Only to choose which full-size file to link to; the instructions themselves are never rendered on a card. */
  edits: true,
} satisfies Prisma.PhotoSelect;

export type PhotoCard = Prisma.PhotoGetPayload<{ select: typeof photoCardSelect }>;

export async function listTripPhotos(tripId: string, uploaderId?: string): Promise<PhotoCard[]> {
  return db.photo.findMany({
    where: { tripId, ...NOT_TRASHED, ...(uploaderId ? { uploaderId } : {}), status: { in: ["READY", "PENDING", "PROCESSING", "FAILED"] } },
    orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: photoCardSelect,
  });
}

const UNASSIGNED_ORDER: KeyColumn[] = [{ field: "createdAt", dir: "desc" }];

/**
 * One page of the photographs on no trip, newest upload first, with a cursor (the last one's id) for the next page.
 *
 * It used to be all of them at once, which after a Takeout import of a decade is thousands of tiles on the one page
 * meant for filing them away. `total` is how many there are with nothing asked; `matched` is how many the filter
 * keeps, so the heading can say both.
 */
export async function unassignedPhotoPage(filter: GalleryFilter = NO_FILTER, opts: { cursor?: string | null; take?: number; /** Only these, for re-reading photos a gallery already holds; any no longer on no trip are left out. */ ids?: string[] } = {}): Promise<{ photos: PhotoCard[]; nextCursor: string | null; matched: number; total: number }> {
  const take = opts.take ?? GALLERY_PAGE;
  const lists: string[][] = [];
  if (opts.ids) lists.push(opts.ids);
  if (filter.q) lists.push(await idsMatching(filter.q, { member: filter.member, scope: { tripId: null } }));
  if (filter.year) lists.push(await idsInLocalYear(null, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  const where = {
    tripId: null,
    ...NOT_TRASHED,
    ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(restrict ? { id: { in: restrict } } : {}),
  };
  const nothing = Boolean(restrict && restrict.length === 0);
  const [photos, matched, total] = await Promise.all([
    nothing
      ? Promise.resolve([])
      : db.photo.findMany({ where: { AND: [where, await cursorWhere(opts.cursor, UNASSIGNED_ORDER, where)] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { ...photoCardSelect, createdAt: true }, take: take + 1 }),
    nothing ? Promise.resolve(0) : db.photo.count({ where }),
    db.photo.count({ where: { tripId: null, ...NOT_TRASHED } }),
  ]);
  const more = photos.length > take;
  const page = more ? photos.slice(0, take) : photos;
  return { photos: page, nextCursor: more ? encodeCursor(page[page.length - 1], UNASSIGNED_ORDER) : null, matched, total };
}
