import { loadViewableCollection } from "@/lib/collections/access";
import { collectionTimeline } from "@/lib/collections/timeline";
import { Timeline } from "@/components/timeline/Timeline";

export default async function CollectionTimelinePage({ params }: PageProps<"/collections/[slug]/timeline">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/timeline`);
  const groups = await collectionTimeline(collection.id);
  return <Timeline groups={groups} tripSlug="" timezone="UTC" showDetailLink={editable} />;
}
