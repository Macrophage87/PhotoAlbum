import { db } from "@/lib/db";
import { favouriteOrderSql } from "@/lib/favourites/queries";
import { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleTripsWhere } from "@/lib/auth/access";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { COVERABLE, coverPhotoSelect, standingCover } from "@/lib/photos/cover";

export const tripCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  descriptionMembersOnly: true,
  startDate: true,
  endDate: true,
  timezone: true,
  themeKey: true,
  visibility: true,
  shareToken: true,
  coverPhoto: coverPhotoSelect,
  _count: { select: { photos: { where: NOT_TRASHED }, activities: true } },
} satisfies Prisma.TripSelect;

export type TripCardData = Prisma.TripGetPayload<{ select: typeof tripCardSelect }>;

/**
 * Trips for the front page, newest first, optionally narrowed by name. Paged: a family that has been at this for
 * twenty years has more trips than anyone wants rendered at once, and every one of them carries a cover photo.
 */
export async function listVisibleTrips(viewer: Viewer, opts: { q?: string | null; take?: number; skip?: number; order?: "favorites" | "newest" | "oldest" } = {}): Promise<TripCardData[]> {
  const where = { ...visibleTripsWhere(viewer), ...(opts.q ? { title: { contains: opts.q, mode: "insensitive" as const } } : {}) };
  // Favourites lead: this member's first, then the ones most of the family marked, then newest. The order is worked
  // out in SQL because "mine" is not something an ordinary orderBy can express, then the rows are fetched by id.
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "Trip" t
    WHERE t."deletingAt" IS NULL AND ${viewer.kind === "user" ? Prisma.sql`TRUE` : Prisma.sql`t.visibility = 'PUBLIC'`}
      AND ${opts.q ? Prisma.sql`t.title ILIKE ${"%" + opts.q + "%"}` : Prisma.sql`TRUE`}
    ${opts.order === "newest"
      ? Prisma.sql`ORDER BY t."startDate" DESC, t.id DESC`
      : opts.order === "oldest"
        ? Prisma.sql`ORDER BY t."startDate" ASC, t.id ASC`
        : viewer.kind === "user"
          ? favouriteOrderSql("trip", "t", viewer.user.id, Prisma.sql`t."startDate" DESC, t.id DESC`)
          : // Favourites first is a member's order; a visitor would read the family's hearts off it. Newest first instead.
            Prisma.sql`ORDER BY t."startDate" DESC, t.id DESC`}
    LIMIT ${opts.take ?? 1000} OFFSET ${opts.skip ?? 0}`;
  const rows = await db.trip.findMany({ where: { ...where, id: { in: ids.map((i) => i.id) } }, select: tripCardSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i.id)).filter((r): r is TripCardData => Boolean(r));
}

/** How many there are in all, so the page can say what it is not showing. */
export async function countVisibleTrips(viewer: Viewer, q?: string | null): Promise<number> {
  return db.trip.count({ where: { ...visibleTripsWhere(viewer), ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}) } });
}

/** A trip being deleted is gone for everybody already (see src/lib/trips/delete.ts). */
export async function getTripBySlug(slug: string) {
  return db.trip.findUnique({
    where: { slug, deletingAt: null },
    include: { coverPhoto: coverPhotoSelect, _count: { select: { photos: { where: NOT_TRASHED }, activities: true, tracks: true } } },
  });
}

export type TripWithCounts = NonNullable<Awaited<ReturnType<typeof getTripBySlug>>>;

type ChosenCover = { id: string; imageVersion: number; width: number | null; height?: number | null; trashedAt?: Date | null; tripId: string | null };

/**
 * The cover chosen by hand, while it still stands: with pictures to draw, out of the trash, and still on this trip. A
 * photograph can be moved to another trip from its own page, a bulk move, or filing, long after it was chosen, and
 * the trip it left must not go on leading with a picture that is no longer on it (and may now be private to somebody
 * else). The choice is not forgotten, only set aside, so one that comes back leads again, as one restored from the
 * trash does. Taking a photograph off the trip on purpose (removeFromTrip) is the owner saying no, and forgets it.
 */
export function chosenTripCover<T extends ChosenCover>(trip: { id: string; coverPhoto: T | null }): T | null {
  const chosen = standingCover(trip.coverPhoto);
  return chosen && chosen.tripId === trip.id ? chosen : null;
}

/** The chosen cover where it still stands, or else the earliest ready photo on the trip. */
export async function coverFor(trip: { id: string; coverPhoto: ChosenCover | null }) {
  const chosen = chosenTripCover(trip);
  if (chosen) return chosen;
  return db.photo.findFirst({
    where: { tripId: trip.id, ...COVERABLE },
    orderBy: [{ takenAt: "asc" }],
    // Width and height go into the link preview: a card without them is often drawn small, or not at all.
    select: { id: true, updatedAt: true, imageVersion: true, width: true, height: true },
  });
}
