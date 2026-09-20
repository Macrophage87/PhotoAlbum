import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSharedTrip } from "@/lib/share/queries";
import { photoCardSelect } from "@/lib/photos/queries";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { NOT_TRASHED } from "@/lib/photos/trash";

export default async function SharedActivityPage({ params }: PageProps<"/share/[token]/activities/[id]">) {
  const { token, id } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, include: { track: { select: { id: true, simplified: true, stats: true } }, participants: { select: { id: true } } } });
  if (!activity) notFound();
  const photos = await db.photo.findMany({ where: { activityId: activity.id, ...NOT_TRASHED }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });
  return <ActivityDetail trip={trip} activity={activity} photos={photos} editable={false} />;
}
