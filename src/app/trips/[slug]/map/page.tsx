import { loadViewableTrip } from "@/lib/trips/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";

export default async function TripMapPage({ params }: PageProps<"/trips/[slug]/map">) {
  const { slug } = await params;
  const { trip } = await loadViewableTrip(slug, `/trips/${slug}/map`);
  return <TripMap src={`/api/trips/${slug}/geojson`} theme={mapThemeOf(getTheme(trip.themeKey))} />;
}
