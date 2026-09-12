import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleTripsWhere } from "@/lib/auth/access";
import { NOT_TRASHED } from "@/lib/photos/trash";

export const tripCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  startDate: true,
  endDate: true,
  timezone: true,
  themeKey: true,
  visibility: true,
  shareToken: true,
  coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } },
  _count: { select: { photos: { where: NOT_TRASHED }, activities: true } },
} satisfies Prisma.TripSelect;

export type TripCardData = Prisma.TripGetPayload<{ select: typeof tripCardSelect }>;

export async function listVisibleTrips(viewer: Viewer): Promise<TripCardData[]> {
  return db.trip.findMany({ where: visibleTripsWhere(viewer), orderBy: { startDate: "desc" }, select: tripCardSelect });
}

export async function getTripBySlug(slug: string) {
  return db.trip.findUnique({
    where: { slug },
    include: { coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } }, _count: { select: { photos: { where: NOT_TRASHED }, activities: true, tracks: true } } },
  });
}

export type TripWithCounts = NonNullable<Awaited<ReturnType<typeof getTripBySlug>>>;

/** Cover photo, or the newest ready photo when no cover is set. */
export async function coverFor(trip: { id: string; coverPhoto: { id: string; updatedAt: Date } | null }) {
  if (trip.coverPhoto) return trip.coverPhoto;
  return db.photo.findFirst({
    where: { tripId: trip.id, ...NOT_TRASHED, status: "READY" },
    orderBy: [{ takenAt: "asc" }],
    select: { id: true, updatedAt: true },
  });
}
