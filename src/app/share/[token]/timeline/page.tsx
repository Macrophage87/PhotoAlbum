import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { Timeline } from "@/components/timeline/Timeline";
import { timelineOrderFor } from "@/lib/timeline/order-choice";
import { OrderToggle } from "@/components/timeline/OrderToggle";

export default async function SharedTimelinePage({ params, searchParams }: PageProps<"/share/[token]/timeline">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const [{ groups }, order] = await Promise.all([tripTimeline(trip.id, trip.timezone), timelineOrderFor(await searchParams, "oldest")]);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <OrderToggle order={order} />
      </div>
      <Timeline groups={groups} tripSlug={trip.slug} timezone={trip.timezone} member={false} activityHrefBase={`/share/${token}/activities`} order={order} />
    </div>
  );
}
