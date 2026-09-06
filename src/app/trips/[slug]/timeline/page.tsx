import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function TripTimelinePage({ params }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const groups = await tripTimeline(trip.id, trip.timezone);
  return <Timeline groups={groups} tripSlug={slug} timezone={trip.timezone} showDetailLink={canEditTrip(viewer)} />;
}
