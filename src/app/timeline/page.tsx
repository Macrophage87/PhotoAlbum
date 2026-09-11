import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { listVisibleTrips } from "@/lib/trips/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Timeline } from "@/components/timeline/Timeline";
import { TripTheme } from "@/themes/TripTheme";
import { db } from "@/lib/db";
import { listVisibleCollections } from "@/lib/collections/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { SelectionProvider } from "@/components/photos/selection";
import { CollectionFilter } from "@/components/collections/CollectionFilter";

export const metadata = { title: "Timeline" };

export default async function GlobalTimelinePage({ searchParams }: PageProps<"/timeline">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const editable = canEditTrip(viewer);
  const collections = await listVisibleCollections(viewer);
  const filter = typeof sp.collection === "string" ? collections.find((c) => c.slug === sp.collection) : undefined;
  const trips = filter ? [] : await listVisibleTrips(viewer);
  const [groups, collectionGroups, tripOptions, collectionOptions] = await Promise.all([
    // The global view shows the first page of each trip; the trip timeline pages through the rest.
    Promise.all(trips.map((t) => tripTimeline(t.id, t.timezone).then((p) => p.groups))),
    filter ? collectionTimeline(filter.id) : Promise.resolve(null),
    editable ? db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
  const body = (
    <>
      {filter && collectionGroups && (
        <TripTheme themeKey={filter.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
          <h2 className="font-display text-2xl font-semibold mb-4">
            <Link href={`/collections/${filter.slug}`} className="hover:underline underline-offset-2">{filter.title}</Link>
          </h2>
          <Timeline groups={collectionGroups} tripSlug="" timezone="UTC" showDetailLink={editable} idPrefix={`c-${filter.slug}`} />
        </TripTheme>
      )}
      {!filter && trips.length === 0 && <p className="text-muted">Nothing to show yet.</p>}
        <div className="space-y-12">
        {trips.map((trip, i) => (
          <TripTheme key={trip.id} themeKey={trip.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
            <div className="mb-4">
              <h2 className="font-display text-2xl font-semibold">
                <Link href={`/trips/${trip.slug}`} className="hover:underline underline-offset-2">
                  {trip.title}
                </Link>
              </h2>
              <p className="text-muted text-sm">{formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate))}</p>
            </div>
            <Timeline groups={groups[i]} tripSlug={trip.slug} timezone={trip.timezone} showDetailLink={editable} idPrefix={`t-${trip.slug}`} />
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
          <CollectionFilter collections={collections.map((c) => ({ slug: c.slug, title: c.title }))} current={filter?.slug ?? ""} basePath="/timeline" />
        </div>
        {editable ? <SelectionProvider trips={tripOptions} collections={collectionOptions}>{body}</SelectionProvider> : body}
      </Container>
    </AppShell>
  );
}
