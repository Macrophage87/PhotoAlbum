import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { decodeCursor, encodeCursor, tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";

export default async function SharedTimelinePage({ params, searchParams }: PageProps<"/share/[token]/timeline">) {
  const { token } = await params;
  const sp = await searchParams;
  const cursor = decodeCursor(typeof sp.after === "string" ? sp.after : undefined);
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const page = await tripTimeline(trip.id, trip.timezone, { cursor });
  return <Timeline groups={page.groups} tripSlug={trip.slug} timezone={trip.timezone} member={false} activityHrefBase={`/share/${token}/activities`} paging={{ base: `/share/${token}/timeline`, paged: Boolean(cursor), next: page.next ? encodeCursor(page.next) : null }} />;
}
