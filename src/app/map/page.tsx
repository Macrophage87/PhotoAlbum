import { getViewer } from "@/lib/auth/viewer";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripMap } from "@/components/map/TripMap";
import { listVisibleCollections } from "@/lib/collections/queries";
import { CollectionFilter } from "@/components/collections/CollectionFilter";
import { ButtonLink } from "@/components/ui";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";

export const metadata = { title: "Map" };

export default async function GlobalMapPage({ searchParams }: PageProps<"/map">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const collections = await listVisibleCollections(viewer);
  const filter = typeof sp.collection === "string" ? collections.find((c) => c.slug === sp.collection) : undefined;
  const narrow = parseGalleryFilter(sp, { member: viewer.kind === "user" });
  const query = filterQuery(narrow);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl font-semibold">Map</h1>
          <div className="flex flex-wrap items-center gap-2">
            {viewer.kind === "user" && <ButtonLink href="/place" size="sm" variant="secondary">Place photos</ButtonLink>}
            <CollectionFilter current={filter ? { slug: filter.slug, title: filter.title } : null} basePath="/map" />
          </div>
        </div>
        <GalleryFilters filter={narrow} action="/map" placeholder="Search the whole album" hidden={filter ? { collection: filter.slug } : undefined} />
        <TripMap
          key={`${filter?.slug ?? "all"}:${query}`}
          src={`${filter ? `/api/collections/${filter.slug}/geojson` : "/api/map/geojson"}${query ? `?${query}` : ""}`}
          theme={mapThemeOf(getTheme(filter?.themeKey ?? "default"))}
          showTripList={!filter}
          narrowed={filterIsActive(narrow)}
        />
      </Container>
    </AppShell>
  );
}
