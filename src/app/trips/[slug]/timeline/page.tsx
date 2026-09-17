import { loadViewableTrip } from "@/lib/trips/access";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";
import { SelectionProvider } from "@/components/photos/selection";

export default async function TripTimelinePage({ params }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/timeline`);
  const groups = await tripTimeline(trip.id, trip.timezone);
  const timeline = <Timeline groups={groups} tripSlug={slug} timezone={trip.timezone} member={editable} />;
  // Members get the selection bar here: a wrong date is usually spotted on the timeline, and this is where a whole
  // day of them can be picked up and corrected at once.
  return editable ? <SelectionProvider>{timeline}</SelectionProvider> : timeline;
}
