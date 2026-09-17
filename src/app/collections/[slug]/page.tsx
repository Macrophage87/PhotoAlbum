import { loadViewableCollection } from "@/lib/collections/access";
import { collectionTimeline } from "@/lib/collections/timeline";
import { describeCount, parseGalleryFilter } from "@/lib/photos/filters";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { Timeline } from "@/components/timeline/Timeline";
import { ButtonLink } from "@/components/ui";

/** What a collection opens on: the days its photographs were taken, in order, and a way to ask it for one of them. */
export default async function CollectionTimelinePage({ params, searchParams }: PageProps<"/collections/[slug]">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { collection, editable } = await loadViewableCollection(slug);
  const filter = parseGalleryFilter(sp, { member: editable });
  const { groups, matched, total, active } = await collectionTimeline(collection.id, filter);
  return (
    <div className="space-y-4">
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>
          <ButtonLink href="/upload" size="sm" variant="secondary">Upload</ButtonLink>
        </div>
      )}
      <GalleryFilters filter={filter} action={`/collections/${slug}`} placeholder="Search this collection" />
      <p className="text-sm text-muted" data-testid="timeline-count">{active ? describeCount(matched, total, true) : `${total} photo${total === 1 ? "" : "s"}`}</p>
      {active && matched === 0 ? (
        <p className="text-muted text-sm" data-testid="no-matches">Nothing here matches that. Try fewer words, or clear the search.</p>
      ) : (
        <Timeline groups={groups} tripSlug="" timezone="UTC" member={editable} />
      )}
    </div>
  );
}
