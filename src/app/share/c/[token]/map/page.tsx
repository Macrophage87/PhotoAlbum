import { notFound } from "next/navigation";
import { getSharedCollection } from "@/lib/share/queries";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";

export default async function SharedCollectionMapPage({ params }: PageProps<"/share/c/[token]/map">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  return <TripMap src={`/api/collections/${collection.slug}/geojson`} theme={mapThemeOf(getTheme(collection.themeKey))} showDetailLink={false} />;
}
