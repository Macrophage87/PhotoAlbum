import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { idsInLocalYear, idsMatching, intersectIds } from "./page";
import { NO_FILTER, type GalleryFilter } from "./filters";
import { idsWithPerson } from "@/lib/people/in-photos";

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

export async function listUnassignedPhotos(filter: GalleryFilter = NO_FILTER): Promise<{ photos: PhotoCard[]; total: number }> {
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q));
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
  const [photos, total] = await Promise.all([
    restrict && restrict.length === 0 ? Promise.resolve([]) : db.photo.findMany({ where, orderBy: [{ createdAt: "desc" }], select: photoCardSelect }),
    db.photo.count({ where: { tripId: null, ...NOT_TRASHED } }),
  ]);
  return { photos, total };
}
