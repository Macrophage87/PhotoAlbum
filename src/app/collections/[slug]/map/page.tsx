import { loadViewableCollection } from "@/lib/collections/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";

export default async function CollectionMapPage({ params }: PageProps<"/collections/[slug]/map">) {
  const { slug } = await params;
  const { collection } = await loadViewableCollection(slug, `/collections/${slug}/map`);
  return <TripMap src={`/api/collections/${slug}/geojson`} theme={mapThemeOf(getTheme(collection.themeKey))} />;
}
