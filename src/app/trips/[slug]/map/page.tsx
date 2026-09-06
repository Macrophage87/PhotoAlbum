import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";

export default async function TripMapPage({ params }: PageProps<"/trips/[slug]/map">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  return <TripMap src={`/api/trips/${slug}/geojson`} theme={mapThemeOf(getTheme(trip.themeKey))} showDetailLink={canEditTrip(viewer)} />;
}
