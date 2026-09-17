import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function SharedTimelinePage({ params }: PageProps<"/share/[token]/timeline">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const { groups } = await tripTimeline(trip.id, trip.timezone);
  return <Timeline groups={groups} tripSlug={trip.slug} timezone={trip.timezone} member={false} activityHrefBase={`/share/${token}/activities`} />;
}
