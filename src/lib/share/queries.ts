import { db } from "@/lib/db";
import { coverPhotoSelect as coverSelect } from "@/lib/photos/cover";
import { NOT_TRASHED } from "@/lib/photos/trash";

/** Trip behind a share token, only while the trip is actually in LINK mode. */
export async function getSharedTrip(token: string) {
  if (!token || token.length > 128) return null;
  const trip = await db.trip.findUnique({
    // Its token goes when it is marked for deletion; asked for here as well, as every trip loader does.
    where: { shareToken: token, deletingAt: null },
    include: { coverPhoto: coverSelect, // Counted as the members' pages count: what is in the trash is off every link, so it is not on the card either.
    _count: { select: { photos: { where: NOT_TRASHED }, activities: true, tracks: true } } },
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
  const activity = await db.activity.findUnique({
    where: { shareToken: token },
    include: { track: { select: { id: true, simplified: true, stats: true } }, participants: { select: { id: true } }, trip: { select: { id: true, slug: true, title: true, themeKey: true, timezone: true, visibility: true } } },
  });
  if (!activity) return null;
  // The link opens the afternoon, not the trip: a trip strangers cannot open is not named to them, and its slug is
  // made from its name, so neither goes to the page.
  const open = activity.trip.visibility === "PUBLIC";
  return { ...activity, trip: { ...activity.trip, slug: open ? activity.trip.slug : null, title: open ? activity.trip.title : null } };
}

/** Collection behind a share token, only while it is in LINK mode. */
export async function getSharedCollection(token: string) {
  if (!token || token.length > 128) return null;
  const collection = await db.collection.findUnique({
    where: { shareToken: token },
    include: { coverPhoto: coverSelect, _count: { select: { items: { where: { photo: NOT_TRASHED } } } } },
  });
  if (!collection || collection.visibility !== "LINK") return null;
  return collection;
}
