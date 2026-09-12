import { getViewer } from "@/lib/auth/viewer";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripMap } from "@/components/map/TripMap";
import { listVisibleCollections } from "@/lib/collections/queries";
import { CollectionFilter } from "@/components/collections/CollectionFilter";

export const metadata = { title: "Map" };

export default async function GlobalMapPage({ searchParams }: PageProps<"/map">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const collections = await listVisibleCollections(viewer);
  const filter = typeof sp.collection === "string" ? collections.find((c) => c.slug === sp.collection) : undefined;
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl font-semibold">Map</h1>
          <CollectionFilter collections={collections.map((c) => ({ slug: c.slug, title: c.title }))} current={filter?.slug ?? ""} basePath="/map" />
        </div>
        <TripMap key={filter?.slug ?? "all"} src={filter ? `/api/collections/${filter.slug}/geojson` : "/api/map/geojson"} theme={mapThemeOf(getTheme(filter?.themeKey ?? "default"))} showTripList={!filter} />
      </Container>
    </AppShell>
  );
}
