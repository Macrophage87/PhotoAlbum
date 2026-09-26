import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { canContribute } from "@/lib/auth/access";
import { listVisibleTrips } from "@/lib/trips/queries";
import { timelineCounts, timelineIds, tripTimeline } from "@/lib/timeline/queries";
import { pageNumber, timelinePages } from "@/lib/timeline/paging";
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
import { peopleInPhotos } from "@/lib/people/in-photos";
import { timelineOrderFor } from "@/lib/timeline/order-choice";
import { OrderToggle } from "@/components/timeline/OrderToggle";

export const metadata = { title: "Timeline" };

export default async function GlobalTimelinePage({ searchParams }: PageProps<"/timeline">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const editable = canContribute(viewer);
  const collections = await listVisibleCollections(viewer);
  const filter = typeof sp.collection === "string" ? collections.find((c) => c.slug === sp.collection) : undefined;
  const narrow = parseGalleryFilter(sp, { member: editable });
  const searching = filterIsActive(narrow);
  const people = viewer.kind === "user" ? await peopleInPhotos() : [];
  // The whole album opens on what is newest, trips and days alike, unless this person has asked for the other way.
  const order = await timelineOrderFor(sp, "newest");
  const trips = filter ? [] : await listVisibleTrips(viewer, { order });
  // The question is asked of the whole album once, not again for every trip, and each trip is counted in one query
  // so the page can be cut before any trip's timeline is loaded.
  const restrict = !filter && searching ? await timelineIds(narrow, null) : null;
  const counts = await timelineCounts(trips.map((t) => t.id), narrow, restrict);
  // A search across everything is a short answer from a few trips, so the ones with nothing in them drop out.
  const candidates = searching ? trips.filter((t) => (counts.get(t.id) ?? 0) > 0) : trips;
  const pages = timelinePages(candidates.map((t) => counts.get(t.id) ?? 0));
  const page = pageNumber(sp.page, pages.length);
  const onPage = pages.length ? candidates.slice(pages[page - 1].start, pages[page - 1].end) : [];
  const [all, collectionGroups] = await Promise.all([
    Promise.all(onPage.map((t) => tripTimeline(t.id, t.timezone, narrow, restrict))),
    filter ? collectionTimeline(filter.id, narrow) : Promise.resolve(null),
  ]);
  const shown = onPage.map((trip, i) => ({ trip, result: all[i] }));
  // The same address a page further on: the search, the order and the collection all stay as they were.
  const href = (n: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (k !== "page") for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) next.append(k, one);
    if (n > 1) next.set("page", String(n));
    const query = next.toString();
    return query ? `/timeline?${query}` : "/timeline";
  };
  const body = (
    <>
      {filter && collectionGroups && (
        <TripTheme themeKey={filter.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
          <h2 className="font-display text-2xl font-semibold mb-4">
            <Link href={`/collections/${filter.slug}`} className="hover:underline underline-offset-2">{filter.title}</Link>
          </h2>
          <Timeline groups={collectionGroups.groups} tripSlug="" timezone="UTC" member={editable} idPrefix={`c-${filter.slug}`} order={order} />
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
            <Timeline groups={result.groups} tripSlug={trip.slug} timezone={trip.timezone} member={editable} idPrefix={`t-${trip.slug}`} order={order} />
          </TripTheme>
        ))}
      </div>
      {!filter && pages.length > 1 && (
        <nav className="mt-10 flex flex-wrap items-center gap-2 text-sm" aria-label="More trips" data-testid="timeline-pages">
          {page > 1 && <Link href={href(page - 1)} className="text-primary hover:underline">← {order === "oldest" ? "Earlier trips" : "Newer trips"}</Link>}
          <span className="text-muted">Page {page} of {pages.length}</span>
          {page < pages.length && <Link href={href(page + 1)} className="text-primary hover:underline">{order === "oldest" ? "Later trips" : "Older trips"} →</Link>}
        </nav>
      )}
    </>
  );
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
          <h1 className="font-display text-3xl font-semibold">Timeline</h1>
          <CollectionFilter current={filter ? { slug: filter.slug, title: filter.title } : null} basePath="/timeline" />
        </div>
        <div className="mb-6 space-y-3">
          <GalleryFilters filter={narrow} action="/timeline" people={people} placeholder="Search the whole album" hidden={filter ? { collection: filter.slug } : undefined} />
          <OrderToggle order={order} />
        </div>
        {editable ? <SelectionProvider>{body}</SelectionProvider> : body}
      </Container>
    </AppShell>
  );
}
