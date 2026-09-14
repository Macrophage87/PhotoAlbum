import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { keeperOf, planFold, type FoldablePhoto } from "./fold-duplicates";

export type DuplicateGroup = { contentHash: string; ids: string[] };

const foldSelect = {
  id: true,
  caption: true,
  title: true,
  context: true,
  takenAt: true,
  takenAtSource: true,
  lat: true,
  lng: true,
  placeName: true,
  gpsSource: true,
  tripId: true,
  activityId: true,
  createdAt: true,
} as const;

/**
 * Groups of photographs whose files are byte for byte the same. Items still being processed have no hash yet and
 * are not guessed at; nor is anything already in the trash, which is where the folding puts the copies.
 */
export async function duplicateGroups(limit = 200): Promise<DuplicateGroup[]> {
  const rows = await db.$queryRaw<{ contentHash: string; ids: string[] }[]>`
    SELECT p."contentHash", array_agg(p.id ORDER BY p."createdAt", p.id) AS ids
    FROM "Photo" p
    WHERE p."contentHash" IS NOT NULL AND p."trashedAt" IS NULL
    GROUP BY p."contentHash"
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT ${limit}`;
  return rows;
}

export type FoldReport = { groups: number; folded: number; filled: string[] };

/**
 * Fold every group into its oldest member: take from the copies whatever the keeper is missing, move any collection
 * membership and any favourite onto the keeper, then put the copies in the trash marked as duplicates.
 *
 * The copies are trashed rather than deleted so that a family which disagrees can have them back; an admin empties
 * the trash when they are satisfied, which is when the disk space is returned.
 */
export async function foldDuplicates(byUserId: string, groups?: DuplicateGroup[]): Promise<FoldReport> {
  const work = groups ?? (await duplicateGroups());
  const report: FoldReport = { groups: 0, folded: 0, filled: [] };
  for (const group of work) {
    const photos = (await db.photo.findMany({ where: { id: { in: group.ids }, ...NOT_TRASHED }, select: foldSelect })) as FoldablePhoto[];
    if (photos.length < 2) continue;
    const keeper = keeperOf(photos);
    const copies = photos.filter((p) => p.id !== keeper.id);

    // Take what the keeper is missing, copy by copy, so an earlier copy's caption is not overwritten by a later one.
    let filling = { ...keeper };
    const data: Record<string, unknown> = {};
    for (const copy of copies) {
      const plan = planFold(filling, copy);
      Object.assign(data, plan.data);
      filling = { ...filling, ...(plan.data as Partial<FoldablePhoto>) };
      for (const f of plan.filled) if (!report.filled.includes(f)) report.filled.push(f);
    }
    if (Object.keys(data).length) await db.photo.update({ where: { id: keeper.id }, data });

    // Wherever a copy was gathered, the keeper belongs instead.
    const memberships = await db.collectionItem.findMany({ where: { photoId: { in: copies.map((c) => c.id) } }, select: { collectionId: true, addedById: true, position: true } });
    for (const m of memberships) {
      await db.collectionItem.upsert({
        where: { collectionId_photoId: { collectionId: m.collectionId, photoId: keeper.id } },
        create: { collectionId: m.collectionId, photoId: keeper.id, position: m.position, addedById: m.addedById },
        update: {},
      });
    }
    // And whoever made a copy a favourite meant the photograph, not that copy of the file.
    const favourites = await db.photoFavorite.findMany({ where: { photoId: { in: copies.map((c) => c.id) } }, select: { userId: true } });
    for (const f of favourites) {
      await db.photoFavorite.upsert({ where: { userId_photoId: { userId: f.userId, photoId: keeper.id } }, create: { photoId: keeper.id, userId: f.userId }, update: {} });
    }

    const trashed = await db.photo.updateMany({
      where: { id: { in: copies.map((c) => c.id) }, ...NOT_TRASHED },
      data: { trashedAt: new Date(), trashedById: byUserId, trashReason: "DUPLICATE", trashNote: `The same file as ${keeper.id}` },
    });
    report.groups += 1;
    report.folded += trashed.count;
  }
  return report;
}
