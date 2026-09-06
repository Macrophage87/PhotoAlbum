import { db } from "@/lib/db";

/** Trip behind a share token, only while the trip is actually in LINK mode. */
export async function getSharedTrip(token: string) {
  if (!token || token.length > 128) return null;
  const trip = await db.trip.findUnique({
    where: { shareToken: token },
    include: { coverPhoto: { select: { id: true, updatedAt: true, width: true, height: true } }, _count: { select: { photos: true, activities: true, tracks: true } } },
  });
  if (!trip || trip.visibility !== "LINK") return null;
  return trip;
}
