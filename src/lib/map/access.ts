import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";

/** Load a track and confirm the viewer may see its trip. */
export async function loadViewableTrack(viewer: Viewer, trackId: string) {
  const track = await db.track.findUnique({ where: { id: trackId }, include: { trip: { select: { id: true, slug: true, visibility: true, shareToken: true, timezone: true } } } });
  if (!track || !canViewTrip(viewer, track.trip)) return null;
  return track;
}
