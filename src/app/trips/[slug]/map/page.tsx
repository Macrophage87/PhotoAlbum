import { loadViewableTrip } from "@/lib/trips/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";
import { ButtonLink } from "@/components/ui";
import { requireUser } from "@/lib/auth/viewer";
import { unplacedForTray } from "@/lib/photos/unplaced";

export default async function TripMapPage({ params }: PageProps<"/trips/[slug]/map">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/map`);
  // A member is told what this trip is still missing from the map, and taken to where it can be put on.
  const waiting = editable ? (await unplacedForTray(await requireUser(`/trips/${slug}/map`), { tripId: trip.id, take: 1 })).total : 0;
  return (
    <div className="space-y-3">
      {waiting > 0 && (
        <p className="text-sm flex flex-wrap items-center gap-3">
          <span className="text-muted">{waiting} photograph{waiting === 1 ? " has" : "s have"} no place on this trip, or only a guessed one.</span>
          <ButtonLink href={`/place?trip=${slug}`} size="sm" variant="secondary">Place them on the map</ButtonLink>
        </p>
      )}
      <TripMap src={`/api/trips/${slug}/geojson`} theme={mapThemeOf(getTheme(trip.themeKey))} />
    </div>
  );
}
