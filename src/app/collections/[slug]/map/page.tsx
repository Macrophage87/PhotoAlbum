import { loadViewableCollection } from "@/lib/collections/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";

export default async function CollectionMapPage({ params, searchParams }: PageProps<"/collections/[slug]/map">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/map`);
  const filter = parseGalleryFilter(await searchParams, { member: editable });
  const query = filterQuery(filter);
  return (
    <div className="space-y-3">
      <GalleryFilters filter={filter} action={`/collections/${slug}/map`} placeholder="Search this collection" />
      <TripMap key={query} src={`/api/collections/${slug}/geojson${query ? `?${query}` : ""}`} theme={mapThemeOf(getTheme(collection.themeKey))} narrowed={filterIsActive(filter)} />
    </div>
  );
}
