import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewActivity, canViewTrip } from "@/lib/auth/access";

/**
 * Load a track and confirm the viewer may see it: through its trip, or through the one activity it is the route of
 * when the viewer holds that activity's link. An activity's link opens its own track and no other on the trip.
 * `viaLink` says it was a link that let them in (the trip's or the activity's), which is not something any cache
 * should keep: a link can be withdrawn.
 */
export async function loadViewableTrack(viewer: Viewer, trackId: string) {
  const track = await db.track.findUnique({
    where: { id: trackId },
    include: { trip: { select: { id: true, slug: true, visibility: true, shareToken: true, timezone: true } }, activity: { select: { id: true, shareToken: true } } },
  });
  if (!track) return null;
  if (canViewTrip(viewer, track.trip)) return { ...track, viaLink: viewer.kind !== "user" && track.trip.visibility !== "PUBLIC" };
  if (track.activity && canViewActivity(viewer, track.activity)) return { ...track, viaLink: true };
  return null;
}
