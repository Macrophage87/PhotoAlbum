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
  placeSetById: true,
  tripId: true,
  activityId: true,
  activitySetById: true,
  createdAt: true,
  status: true,
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

/**
 * `conflicts`: kept photographs whose hand-pinned place was kept although a copy's place had been removed by hand.
 * `coversReleased`: trips, activities and collections that led with a copy the keeper could not stand in for.
 */
export type FoldReport = { groups: number; folded: number; filled: string[]; conflicts: string[]; coversReleased: string[] };

/**
 * Fold every group into its oldest finished member: take from the copies whatever the keeper is missing, move any
 * collection membership, favourite and hand-chosen cover onto the keeper, then put the copies in the trash marked as
 * duplicates.
 *
 * The copies are trashed rather than deleted so that a family which disagrees can have them back; an admin empties
 * the trash when they are satisfied, which is when the disk space is returned.
 */
export async function foldDuplicates(byUserId: string, groups?: DuplicateGroup[]): Promise<FoldReport> {
  const work = groups ?? (await duplicateGroups());
  const report: FoldReport = { groups: 0, folded: 0, filled: [], conflicts: [], coversReleased: [] };
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
      if (plan.conflict && !report.conflicts.includes(keeper.id)) report.conflicts.push(keeper.id);
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
    // A copy somebody chose as a cover was chosen for the picture, which the keeper is too. It takes the copy's place
    // wherever it now sits: every collection a copy was in (it has just joined them), and the trip and activity it
    // ends up on. Anywhere else goes back to choosing for itself, since a cover that is not there would not stand.
    const copyIds = copies.map((c) => c.id);
    await db.collection.updateMany({ where: { coverPhotoId: { in: copyIds }, items: { some: { photoId: keeper.id } } }, data: { coverPhotoId: keeper.id } });
    if (filling.tripId) await db.trip.updateMany({ where: { id: filling.tripId, coverPhotoId: { in: copyIds } }, data: { coverPhotoId: keeper.id } });
    if (filling.activityId) await db.activity.updateMany({ where: { id: filling.activityId, coverPhotoId: { in: copyIds } }, data: { coverPhotoId: keeper.id } });
    // Whatever still names a copy goes back to choosing for itself once the copy is in the trash; say which, rather
    // than let a hand-chosen cover change without a word. Only those the copy was actually fronting: one that had
    // already moved on, or had no pictures, was not being shown, and nothing changes there that anyone would see.
    const cover = { select: { id: true, tripId: true, activityId: true, width: true } } as const;
    const [trips, activities, collections] = await Promise.all([
      db.trip.findMany({ where: { coverPhotoId: { in: copyIds } }, select: { id: true, title: true, coverPhoto: cover } }),
      db.activity.findMany({ where: { coverPhotoId: { in: copyIds } }, select: { id: true, title: true, coverPhoto: cover } }),
      db.collection.findMany({ where: { coverPhotoId: { in: copyIds } }, select: { title: true, coverPhoto: cover, items: { where: { photoId: { in: copyIds } }, select: { photoId: true } } } }),
    ]);
    const shown = [
      ...trips.filter((t) => t.coverPhoto?.tripId === t.id && t.coverPhoto.width !== null),
      ...activities.filter((a) => a.coverPhoto?.activityId === a.id && a.coverPhoto.width !== null),
      ...collections.filter((c) => c.coverPhoto?.width != null && c.items.some((i) => i.photoId === c.coverPhoto!.id)),
    ];
    for (const c of shown) if (!report.coversReleased.includes(c.title)) report.coversReleased.push(c.title);

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
