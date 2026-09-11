import { loadViewableTrip } from "@/lib/trips/access";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function TripTimelinePage({ params, searchParams }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const sp = await searchParams;
  const after = typeof sp.after === "string" && !Number.isNaN(Date.parse(sp.after)) ? new Date(sp.after) : null;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/timeline`);
  const page = await tripTimeline(trip.id, trip.timezone, { after });
  return <Timeline groups={page.groups} tripSlug={slug} timezone={trip.timezone} showDetailLink={editable} paging={{ base: `/trips/${slug}/timeline`, after, nextAfter: page.nextAfter }} />;
}
