import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { photoCardSelect } from "@/lib/photos/queries";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { deleteActivity, updateActivity } from "../actions";

export default async function ActivityPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]">) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const editable = canEditTrip(viewer);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, include: { track: { select: { id: true, simplified: true, stats: true } } } });
  if (!activity) notFound();
  const photos = await db.photo.findMany({ where: { activityId: activity.id }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });

  if (!editable) return <ActivityDetail trip={trip} activity={activity} photos={photos} editable={false} />;
  return (
    <ActivityDetail
      trip={trip}
      activity={activity}
      photos={photos}
      editable
      editing={sp.edit === "1"}
      updateAction={updateActivity.bind(null, slug, activity.id) as never}
      deleteAction={deleteActivity.bind(null, slug, activity.id)}
    />
  );
}
