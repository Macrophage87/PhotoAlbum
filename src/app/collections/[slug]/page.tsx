import { loadViewableCollection } from "@/lib/collections/access";
import { collectionTimeline } from "@/lib/collections/timeline";
import { describeCount, parseGalleryFilter } from "@/lib/photos/filters";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { Timeline } from "@/components/timeline/Timeline";
import { SelectionProvider } from "@/components/photos/selection";
import { ButtonLink } from "@/components/ui";
import { peopleInPhotos } from "@/lib/people/in-photos";
import { timelineOrderFor } from "@/lib/timeline/order-choice";
import { OrderToggle } from "@/components/timeline/OrderToggle";
import { CollectionUploader } from "@/components/collections/CollectionUploader";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";

/** What a collection opens on: the days its photographs were taken, in order, and a way to ask it for one of them. */
export default async function CollectionTimelinePage({ params, searchParams }: PageProps<"/collections/[slug]">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { collection, editable } = await loadViewableCollection(slug);
  const filter = parseGalleryFilter(sp, { member: editable });
  const order = await timelineOrderFor(sp, "oldest");
  const [{ groups, matched, total, active }, people, gates] = await Promise.all([
    collectionTimeline(collection.id, filter),
    editable ? peopleInPhotos({ collectionId: collection.id }) : Promise.resolve([]),
    editable ? annotationGates() : Promise.resolve(null),
  ]);
  const timeline = (
    <div className="space-y-4">
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>
          <CollectionUploader collectionId={collection.id} slug={slug} maxClipSeconds={env().MAX_CLIP_SECONDS} annotationActive={Boolean(gates?.active)} />
        </div>
      )}
      <GalleryFilters filter={filter} action={`/collections/${slug}`} people={editable ? people : undefined} placeholder="Search this collection" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" data-testid="timeline-count">{active ? describeCount(matched, total, true) : `${total} photo${total === 1 ? "" : "s"}`}</p>
        <OrderToggle order={order} />
      </div>
      {active && matched === 0 ? (
        <p className="text-muted text-sm" data-testid="no-matches">Nothing here matches that. Try fewer words, or clear the search.</p>
      ) : (
        <Timeline groups={groups} tripSlug="" timezone="UTC" member={editable} order={order} />
      )}
    </div>
  );
  // Members get the selection bar here, as on a trip. Without it every "Select this day" beside a heading renders
  // nothing at all — the control asks the selection for its state and quietly gives up when there is none — so a
  // gathering was the one timeline in the album where a whole day could not be picked up.
  return editable ? <SelectionProvider>{timeline}</SelectionProvider> : timeline;
}
