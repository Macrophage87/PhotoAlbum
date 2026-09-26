import { notFound } from "next/navigation";
import { getSharedCollection } from "@/lib/share/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { Timeline } from "@/components/timeline/Timeline";
import { timelineOrderFor } from "@/lib/timeline/order-choice";
import { OrderToggle } from "@/components/timeline/OrderToggle";

export default async function SharedCollectionTimelinePage({ params, searchParams }: PageProps<"/share/c/[token]/timeline">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  const [{ groups }, order] = await Promise.all([collectionTimeline(collection.id), timelineOrderFor(await searchParams, "oldest")]);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <OrderToggle order={order} />
      </div>
      <Timeline groups={groups} tripSlug="" timezone="UTC" member={false} order={order} />
    </div>
  );
}
