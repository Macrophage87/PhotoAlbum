import { loadViewableTrip } from "@/lib/trips/access";
import { decodeCursor, encodeCursor, tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";
import { SelectionProvider } from "@/components/photos/selection";

export default async function TripTimelinePage({ params, searchParams }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const sp = await searchParams;
  const cursor = decodeCursor(typeof sp.after === "string" ? sp.after : undefined);
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/timeline`);
  const page = await tripTimeline(trip.id, trip.timezone, { cursor });
  const timeline = <Timeline groups={page.groups} tripSlug={slug} timezone={trip.timezone} member={editable} paging={{ base: `/trips/${slug}/timeline`, paged: Boolean(cursor), next: page.next ? encodeCursor(page.next) : null }} />;
  // Members get the selection bar here: a wrong date is usually spotted on the timeline, and this is where a whole
  // day of them can be picked up and corrected at once.
  return editable ? <SelectionProvider>{timeline}</SelectionProvider> : timeline;
}
