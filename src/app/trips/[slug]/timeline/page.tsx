import { loadViewableTrip } from "@/lib/trips/access";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function TripTimelinePage({ params }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/timeline`);
  const groups = await tripTimeline(trip.id, trip.timezone);
  return <Timeline groups={groups} tripSlug={slug} timezone={trip.timezone} showDetailLink={editable} />;
}
