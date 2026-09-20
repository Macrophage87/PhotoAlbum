import { db } from "@/lib/db";

const coverSelect = { select: { id: true, updatedAt: true, width: true, height: true, trashedAt: true } } as const;

/** Trip behind a share token, only while the trip is actually in LINK mode. */
export async function getSharedTrip(token: string) {
  if (!token || token.length > 128) return null;
  const trip = await db.trip.findUnique({
    where: { shareToken: token },
    include: { coverPhoto: coverSelect, _count: { select: { photos: true, activities: true, tracks: true } } },
  });
  if (!trip || trip.visibility !== "LINK") return null;
  return trip;
}

/**
 * Activity behind a share token. There is no mode to check: a token exists only while the activity is shared, and
 * stopping the sharing clears it, so holding an old link finds nothing.
 */
export async function getSharedActivity(token: string) {
  if (!token || token.length > 128) return null;
  return db.activity.findUnique({
    where: { shareToken: token },
    include: { track: { select: { id: true, simplified: true, stats: true } }, participants: { select: { id: true } }, trip: { select: { id: true, slug: true, title: true, themeKey: true, timezone: true } } },
  });
}

/** Collection behind a share token, only while it is in LINK mode. */
export async function getSharedCollection(token: string) {
  if (!token || token.length > 128) return null;
  const collection = await db.collection.findUnique({
    where: { shareToken: token },
    include: { coverPhoto: coverSelect, _count: { select: { items: true } } },
  });
  if (!collection || collection.visibility !== "LINK") return null;
  return collection;
}
