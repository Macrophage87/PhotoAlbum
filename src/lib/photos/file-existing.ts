import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth/ownership";
import type { ViewerUser } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/** Where somebody was putting what they sent: a trip, one of its activities, a collection, or any of them. */
export type FilingTarget = { tripId?: string | null; activityId?: string | null; collectionId?: string | null };

/** What happened to the photograph the album already had. */
export type Filed = {
  /** Now on the trip asked for (and on the activity, when one was asked for). */
  trip: boolean;
  activity: boolean;
  /** Now in the collection asked for. */
  collection: boolean;
  /** The trip it was taken off, when putting it on the one asked for moved it. */
  movedFrom: string | null;
  /** It is somebody else's, and only they or an admin can move it; it was left where it was. */
  notYours: boolean;
};

const NOTHING: Filed = { trip: false, activity: false, collection: false, movedFrom: null, notYours: false };

/**
 * A file the album already holds, sent again to a particular trip, activity or collection, is filed there rather
 * than kept twice.
 *
 * The same file uploaded into "Acadia" is a member saying where it belongs, and that it is already in the album is
 * no reason to ignore them; nor is it a reason to make a second copy, which would then need folding back into one.
 * So the one the album has is put there: onto the trip (off whichever it was on, since a photograph is on one trip),
 * onto the activity, into the collection (as well as any others it is in, since a collection is a label, not a place).
 *
 * The usual rule about whose photograph it is still holds: only whoever added it, or an admin, may move it. Anyone
 * else is told whose it is and it stays where it is — sending the same file again does not make it yours.
 */
export async function fileExisting(user: Pick<ViewerUser, "id" | "role">, photoId: string, target: FilingTarget): Promise<Filed> {
  const wantsTrip = Boolean(target.activityId || target.tripId);
  if (!wantsTrip && !target.collectionId) return NOTHING;
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, uploaderId: true, tripId: true, activityId: true, trip: { select: { title: true } } } });
  if (!photo) return NOTHING;
  if (!isAdmin(user) && photo.uploaderId !== user.id) return { ...NOTHING, notYours: true };
  const out: Filed = { ...NOTHING };

  if (target.activityId) {
    const activity = await db.activity.findUnique({ where: { id: target.activityId }, select: { id: true, tripId: true } });
    if (activity) {
      if (photo.activityId !== activity.id || photo.tripId !== activity.tripId) {
        await db.photo.update({ where: { id: photo.id }, data: { tripId: activity.tripId, activityId: activity.id, activitySetById: user.id } });
      }
      out.trip = true;
      out.activity = true;
      if (photo.tripId && photo.tripId !== activity.tripId) out.movedFrom = photo.trip?.title ?? null;
      if (photo.tripId !== activity.tripId) await geotag(activity.tripId);
    }
  } else if (target.tripId) {
    const trip = await db.trip.findUnique({ where: { id: target.tripId }, select: { id: true } });
    if (trip) {
      // Onto another trip, it comes off its old trip's activity too: an activity is a part of one trip.
      if (photo.tripId !== trip.id) {
        await db.photo.update({ where: { id: photo.id }, data: { tripId: trip.id, activityId: null, activitySetById: null } });
        if (photo.tripId) out.movedFrom = photo.trip?.title ?? null;
        await geotag(trip.id);
      }
      out.trip = true;
    }
  }

  if (target.collectionId) {
    const collection = await db.collection.findUnique({ where: { id: target.collectionId }, select: { id: true } });
    if (collection) {
      const held = await db.collectionItem.findFirst({ where: { collectionId: collection.id, photoId: photo.id }, select: { photoId: true } });
      if (!held) {
        const last = await db.collectionItem.findFirst({ where: { collectionId: collection.id }, orderBy: { position: "desc" }, select: { position: true } });
        await db.collectionItem.create({ data: { collectionId: collection.id, photoId: photo.id, addedById: user.id, position: (last?.position ?? -1) + 1 } });
        await db.collection.update({ where: { id: collection.id }, data: { updatedAt: new Date() } });
        // The same as adding from the picker: who may see a photograph has changed, so its addresses change with it.
        await db.photo.updateMany({ where: { collections: { some: { collectionId: collection.id } } }, data: { updatedAt: new Date() } });
      }
      out.collection = true;
    }
  }
  return out;
}

/** A photograph new to a trip may be placed from that trip's tracks, as moving one there by hand does. */
async function geotag(tripId: string) {
  await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true }).catch(() => undefined);
}
