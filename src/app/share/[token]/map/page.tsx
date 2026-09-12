import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";

export default async function SharedMapPage({ params }: PageProps<"/share/[token]/map">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  return <TripMap src={`/api/trips/${trip.slug}/geojson`} theme={mapThemeOf(getTheme(trip.themeKey))} activityHrefBase={`/share/${token}/activities`} />;
}
