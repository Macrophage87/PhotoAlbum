import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { favouriteOrderSql } from "@/lib/favourites/queries";
import { photoCardSelect, type PhotoCard } from "./queries";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { NO_FILTER, type GalleryFilter } from "./filters";
import { boundingBox, MILE_IN_METRES, NO_PICKER_FILTER, type PickerFilter } from "./picker-filter";
import { idsWithPerson } from "@/lib/people/in-photos";

/** Gallery pages load this many items at a time; the client asks for the next page by cursor. */
export const GALLERY_PAGE = 240;

export type PhotoPage = { photos: PhotoCard[]; nextCursor: string | null; total: number };

/** How a gallery is ordered: favourites first (the default), or straight through in the order the photos were taken. */
export type PhotoOrder = "favorites" | "taken";

/**
 * Which items a search matches, as a list of ids.
 *
 * The same index the search page uses — captions, titles, notes, the AI's description and tags, and for members the
 * names of the people in the picture — plus the file's own name, because "DSC_0421" is sometimes all anyone
 * remembers. A separate query rather than a join so both ways of ordering a gallery can use it unchanged.
 */
export async function idsMatching(q: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p, LATERAL (SELECT websearch_to_tsquery('english', ${q}) || websearch_to_tsquery('simple', ${q}) AS query) qq
    WHERE p."trashedAt" IS NULL AND (p."searchVectorMembers" @@ qq.query OR p."originalName" ILIKE ${"%" + q + "%"} OR p.caption ILIKE ${"%" + q + "%"} OR p.title ILIKE ${"%" + q + "%"})
    LIMIT 5000`;
  return rows.map((r) => r.id);
}

/**
 * Which items fall in a given year *where they were taken*. A photograph taken on New Year's Eve in Maine is a
 * photograph from that year, not from the next one because UTC had already turned over — so the offset recorded
 * with it is added before the year is read off. Answered as ids so that both ways of ordering a gallery, and the
 * count beside it, agree exactly on what is in it.
 */
export async function idsInLocalYear(tripId: string | null, year: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p
    WHERE p."trashedAt" IS NULL
      AND ${tripId ? Prisma.sql`p."tripId" = ${tripId}` : Prisma.sql`TRUE`}
      AND EXTRACT(YEAR FROM (p."takenAt" + make_interval(mins => COALESCE(p."tzOffsetMin", 0)))) = ${year}`;
  return rows.map((r) => r.id);
}

/** Everything in every list, and nothing else. */
export function intersectIds(lists: string[][]): string[] {
  if (!lists.length) return [];
  return lists.reduce((acc, list) => {
    const here = new Set(list);
    return acc.filter((id) => here.has(id));
  });
}

/** One page of a trip's gallery in capture order, with a cursor (the last item's id) for the next page. */
export async function tripPhotoPage(tripId: string, opts: { uploaderId?: string; cursor?: string | null; take?: number; viewerId?: string | null; order?: PhotoOrder; filter?: GalleryFilter } = {}): Promise<PhotoPage> {
  const take = opts.take ?? GALLERY_PAGE;
  // `uploaderId` predates the filter and still works on its own, so a link somebody kept goes on working.
  const filter: GalleryFilter = { ...NO_FILTER, ...opts.filter, uploaderId: opts.filter?.uploaderId ?? opts.uploaderId ?? null };
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q));
  if (filter.year) lists.push(await idsInLocalYear(tripId, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  // Nothing matched: say so without asking the database a question whose answer is already known.
  if (restrict && restrict.length === 0) return { photos: [], nextCursor: null, total: 0 };

  const where: Prisma.PhotoWhereInput = {
    tripId,
    ...NOT_TRASHED,
    ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.activityId ? { activityId: filter.activityId } : {}),
    ...(restrict ? { id: { in: restrict } } : {}),
    status: { in: ["READY", "PENDING", "PROCESSING", "FAILED"] },
  };
  const order = opts.order ?? "favorites";
  if (order === "favorites") {
    // Favourites lead, then the family's, then the order the day happened in. The cursor is how far down the list
    // we are: the sort key is computed, so there is nothing stable to key from, and a page is 240 rows.
    const skip = Number(opts.cursor ?? 0) || 0;
    const [ids, total] = await Promise.all([
      db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Photo" p
        WHERE p."tripId" = ${tripId} AND p."trashedAt" IS NULL
          AND p.status IN ('READY', 'PENDING', 'PROCESSING', 'FAILED')
          AND ${filter.uploaderId ? Prisma.sql`p."uploaderId" = ${filter.uploaderId}` : Prisma.sql`TRUE`}
          AND ${filter.kind ? Prisma.sql`p.kind = ${filter.kind}::"MediaKind"` : Prisma.sql`TRUE`}
          AND ${filter.activityId ? Prisma.sql`p."activityId" = ${filter.activityId}` : Prisma.sql`TRUE`}
          AND ${restrict ? Prisma.sql`p.id IN (${Prisma.join(restrict)})` : Prisma.sql`TRUE`}
        ${favouriteOrderSql("photo", "p", opts.viewerId ?? null, Prisma.sql`p."takenAt" ASC NULLS LAST, p."createdAt" ASC, p.id ASC`)}
        LIMIT ${take + 1} OFFSET ${skip}`,
      db.photo.count({ where }),
    ]);
    const more = ids.length > take;
    const wanted = (more ? ids.slice(0, take) : ids).map((i) => i.id);
    const rows = await db.photo.findMany({ where: { id: { in: wanted } }, select: photoCardSelect });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const photos = wanted.map((id) => byId.get(id)).filter((p): p is PhotoCard => Boolean(p));
    return { photos, nextCursor: more ? String(skip + take) : null, total };
  }
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

/** Where the picked photographs are going, so the picker never offers what is already there. */
export type PickerTarget = { kind: "collection"; id: string } | { kind: "trip"; id: string };

/**
 * Which photographs are within a distance of a point.
 *
 * Answered as ids, like the search, so it composes with everything else the picker can ask. The box comes first so
 * the index on the two columns does the coarse work; the real great-circle distance is then measured on what the
 * box let through, because a box is not a circle and its corners are half again as far away as its sides.
 */
export async function idsNear(near: { lat: number; lng: number; miles: number }): Promise<string[]> {
  const box = boundingBox(near.lat, near.lng, near.miles);
  const metres = near.miles * MILE_IN_METRES;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p
    WHERE p."trashedAt" IS NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL
      AND p.lat BETWEEN ${box.latMin} AND ${box.latMax}
      AND p.lng BETWEEN ${box.lngMin} AND ${box.lngMax}
      AND 2 * 6371008.8 * asin(sqrt(
            power(sin((radians(p.lat) - radians(${near.lat})) / 2), 2)
            + cos(radians(${near.lat})) * cos(radians(p.lat)) * power(sin((radians(p.lng) - radians(${near.lng})) / 2), 2)
          )) <= ${metres}`;
  return rows.map((r) => r.id);
}

/**
 * Photographs that could be added to a trip or a collection, newest first.
 *
 * Whatever is already in the target is never offered. Everything else the filter asks is either a plain column or
 * an id list — words, and a distance from a point — and where two are asked at once only what satisfies both is
 * kept, so the count beside the grid always matches what is in it.
 */
export async function candidatePhotoPage(target: PickerTarget, filter: PickerFilter = NO_PICKER_FILTER, opts: { cursor?: string | null; take?: number } = {}): Promise<PhotoPage> {
  const take = opts.take ?? GALLERY_PAGE;
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q));
  if (filter.near) lists.push(await idsNear(filter.near));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  if (restrict && restrict.length === 0) return { photos: [], nextCursor: null, total: 0 };

  const from = filter.from ? new Date(`${filter.from}T00:00:00Z`) : null;
  const to = filter.to ? new Date(`${filter.to}T23:59:59.999Z`) : null;
  // Gathered as a list rather than as one object: two of these ask about the trip, and a second `tripId` key in an
  // object literal would quietly replace the first — which is how the picker came to hide what it was built to
  // offer. `not` is spelled out with the null case beside it because SQL's `<>` is not true of a null, so asking
  // for "not this trip" on its own leaves out everything on no trip at all.
  const and: Prisma.PhotoWhereInput[] = [
    target.kind === "collection"
      ? { collections: { none: { collectionId: target.id } } }
      : { OR: [{ tripId: null }, { tripId: { not: target.id } }] },
  ];
  // Nothing has claimed these: no trip, and in no collection. The pile that most wants tidying away.
  if (filter.loose) and.push({ tripId: null, collections: { none: {} } });
  else if (filter.trip === "none") and.push({ tripId: null });
  else if (filter.trip) and.push({ tripId: filter.trip });
  if (filter.kind) and.push({ kind: filter.kind });
  if (filter.uploaderId) and.push({ uploaderId: filter.uploaderId });
  if (from || to) and.push({ takenAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
  if (restrict) and.push({ id: { in: restrict } });

  const where: Prisma.PhotoWhereInput = { status: "READY", ...NOT_TRASHED, AND: and };
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

/** How many the overview page shows. */
export const OVERVIEW_SAMPLE = 10;

/**
 * A handful of a trip's photographs, chosen afresh every time the page is opened.
 *
 * The overview used to show the ten most recent, which meant the same ten for ever once a trip was over — the last
 * afternoon of a fortnight, again and again, while the other nine hundred were never seen by anyone who did not go
 * looking. Picking at random turns the overview into a way of coming across things again.
 *
 * `ORDER BY random()` reads the trip's rows to sort them, which is the right trade at family scale: a trip is
 * hundreds or a few thousand photographs, and the alternatives all bias the choice or go stale.
 */
export async function randomTripPhotos(tripId: string, take = OVERVIEW_SAMPLE): Promise<PhotoCard[]> {
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p
    WHERE p."tripId" = ${tripId} AND p."trashedAt" IS NULL AND p.status = 'READY'
    ORDER BY random()
    LIMIT ${take}`;
  if (!ids.length) return [];
  const rows = await db.photo.findMany({ where: { id: { in: ids.map((i) => i.id) } }, select: photoCardSelect });
  // Keep the order the database chose, so the shuffle is a shuffle rather than capture order in disguise.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i.id)).filter((p): p is PhotoCard => Boolean(p));
}
