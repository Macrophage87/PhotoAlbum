"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditContainer, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { deleteTrackAndItsPositions } from "@/lib/tracks/remove";
import { forgetTrackFiles } from "@/lib/tracks/files";

/**
 * Delete one of a trip's tracks that no activity holds: a Google trace, or the track an activity left behind when it
 * was deleted without it, which otherwise nothing could reach. The positions it gave go with it (and the photos are
 * placed again from what is left), and its file once no other track refers to it. Arranged like the trip's activities:
 * by its maker, or an admin. A track an activity holds is deleted with the activity instead.
 */
export async function deleteLooseTrack(slug: string, trackId: string): Promise<void> {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug, deletingAt: null }, select: { id: true, createdById: true } });
  if (!trip) throw new Error("Trip not found");
  if (!canEditContainer(user, trip)) throw new Error(NOT_YOUR_CONTAINER);
  const track = await db.track.findFirst({ where: { id: trackId, tripId: trip.id, activity: null }, select: { id: true, originalFile: true } });
  if (!track) return;
  await deleteTrackAndItsPositions(track.id);
  await forgetTrackFiles([track.originalFile]);
  revalidatePath(`/trips/${slug}`, "layout");
}
