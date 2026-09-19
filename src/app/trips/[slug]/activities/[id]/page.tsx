import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { deleteActivity, setActivityShare, updateActivity } from "../actions";
import { shareableActivityUrl } from "@/lib/share/social";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";

export default async function ActivityPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]">) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { trip, editable, owns } = await loadViewableTrip(slug, `/trips/${slug}/activities/${id}`);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, include: { track: { select: { id: true, simplified: true, stats: true } } } });
  if (!activity) notFound();
  const photos = await db.photo.findMany({ where: { activityId: activity.id, ...NOT_TRASHED }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });

  // Any member may add their own photos to an activity; rearranging the activity itself belongs to the trip's maker.
  const upload = editable ? { maxClipSeconds: env().MAX_CLIP_SECONDS, annotationActive: (await annotationGates()).active } : undefined;
  if (!owns) return <ActivityDetail trip={trip} activity={activity} photos={photos} upload={upload} editable={false} />;
  // Sharing an activity shapes what leaves the album, so it belongs with the rest of arranging the trip.
  const share = {
    url: shareableActivityUrl(activity, env().APP_URL),
    enable: setActivityShare.bind(null, slug, activity.id, true),
    disable: setActivityShare.bind(null, slug, activity.id, false),
  };
  return (
    <ActivityDetail
      trip={trip}
      activity={activity}
      photos={photos}
      upload={upload}
      share={share}
      editable
      editing={sp.edit === "1"}
      updateAction={updateActivity.bind(null, slug, activity.id) as never}
      deleteAction={deleteActivity.bind(null, slug, activity.id)}
    />
  );
}
