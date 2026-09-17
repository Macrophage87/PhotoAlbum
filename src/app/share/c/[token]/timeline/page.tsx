import { notFound } from "next/navigation";
import { getSharedCollection } from "@/lib/share/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { Timeline } from "@/components/timeline/Timeline";

export default async function SharedCollectionTimelinePage({ params }: PageProps<"/share/c/[token]/timeline">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  const { groups } = await collectionTimeline(collection.id);
  return <Timeline groups={groups} tripSlug="" timezone="UTC" member={false} />;
}
