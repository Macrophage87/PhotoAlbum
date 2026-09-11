import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function SharedTimelinePage({ params, searchParams }: PageProps<"/share/[token]/timeline">) {
  const { token } = await params;
  const sp = await searchParams;
  const after = typeof sp.after === "string" && !Number.isNaN(Date.parse(sp.after)) ? new Date(sp.after) : null;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const page = await tripTimeline(trip.id, trip.timezone, { after });
  return <Timeline groups={page.groups} tripSlug={trip.slug} timezone={trip.timezone} showDetailLink={false} activityHrefBase={`/share/${token}/activities`} paging={{ base: `/share/${token}/timeline`, after, nextAfter: page.nextAfter }} />;
}
