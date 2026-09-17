import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { canContribute } from "@/lib/auth/access";
import { listVisibleTrips } from "@/lib/trips/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Timeline } from "@/components/timeline/Timeline";
import { TripTheme } from "@/themes/TripTheme";
import { listVisibleCollections } from "@/lib/collections/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { SelectionProvider } from "@/components/photos/selection";
import { CollectionFilter } from "@/components/collections/CollectionFilter";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { filterIsActive, parseGalleryFilter } from "@/lib/photos/filters";

export const metadata = { title: "Timeline" };

export default async function GlobalTimelinePage({ searchParams }: PageProps<"/timeline">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const editable = canContribute(viewer);
  const collections = await listVisibleCollections(viewer);
  const filter = typeof sp.collection === "string" ? collections.find((c) => c.slug === sp.collection) : undefined;
  const narrow = parseGalleryFilter(sp, { member: editable });
  const searching = filterIsActive(narrow);
  const trips = filter ? [] : await listVisibleTrips(viewer);
  const [all, collectionGroups] = await Promise.all([
    Promise.all(trips.map((t) => tripTimeline(t.id, t.timezone, narrow))),
    filter ? collectionTimeline(filter.id, narrow) : Promise.resolve(null),
  ]);
  // A search across everything is a short answer from a few trips, so the ones with nothing in them drop out.
  const shown = trips.map((trip, i) => ({ trip, result: all[i] })).filter(({ result }) => !searching || result.matched > 0);
  const body = (
    <>
      {filter && collectionGroups && (
        <TripTheme themeKey={filter.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
          <h2 className="font-display text-2xl font-semibold mb-4">
            <Link href={`/collections/${filter.slug}`} className="hover:underline underline-offset-2">{filter.title}</Link>
          </h2>
          <Timeline groups={collectionGroups.groups} tripSlug="" timezone="UTC" member={editable} idPrefix={`c-${filter.slug}`} />
        </TripTheme>
      )}
      {!filter && trips.length === 0 && <p className="text-muted">Nothing to show yet.</p>}
      {!filter && searching && shown.length === 0 && <p className="text-muted" data-testid="no-matches">Nothing in the album matches that.</p>}
        <div className="space-y-12">
        {shown.map(({ trip, result }) => (
          <TripTheme key={trip.id} themeKey={trip.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
            <div className="mb-4">
              <h2 className="font-display text-2xl font-semibold">
                <Link href={`/trips/${trip.slug}`} className="hover:underline underline-offset-2">
                  {trip.title}
                </Link>
              </h2>
              <p className="text-muted text-sm">{formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate))}</p>
            </div>
            <Timeline groups={result.groups} tripSlug={trip.slug} timezone={trip.timezone} member={editable} idPrefix={`t-${trip.slug}`} />
          </TripTheme>
        ))}
      </div>
    </>
  );
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
          <h1 className="font-display text-3xl font-semibold">Timeline</h1>
          <CollectionFilter current={filter ? { slug: filter.slug, title: filter.title } : null} basePath="/timeline" />
        </div>
        <div className="mb-6">
          <GalleryFilters filter={narrow} action="/timeline" placeholder="Search the whole album" />
        </div>
        {editable ? <SelectionProvider>{body}</SelectionProvider> : body}
      </Container>
    </AppShell>
  );
}
