import { loadViewableTrip } from "@/lib/trips/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { TripMap } from "@/components/map/TripMap";
import { ButtonLink } from "@/components/ui";
import { requireUser } from "@/lib/auth/viewer";
import { unplacedForTray } from "@/lib/photos/unplaced";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { db } from "@/lib/db";
import { uploaderLabel } from "@/components/photos/toGrid";
import { filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";
import { peopleInPhotos } from "@/lib/people/in-photos";

export default async function TripMapPage({ params, searchParams }: PageProps<"/trips/[slug]/map">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/map`);
  // A member is told what this trip is still missing from the map, and taken to where it can be put on.
  const waiting = editable ? (await unplacedForTray(await requireUser(`/trips/${slug}/map`), { tripId: trip.id, take: 1 })).total : 0;
  // The same question the timeline and the gallery take, asked of where things happened instead of when.
  const filter = parseGalleryFilter(sp, { member: editable });
  const query = filterQuery(filter);
  const [activities, members, people] = await Promise.all([
    db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }),
    editable ? db.user.findMany({ where: { photos: { some: { tripId: trip.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    editable ? peopleInPhotos({ tripId: trip.id }) : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-3">
      <GalleryFilters
        filter={filter}
        action={`/trips/${slug}/map`}
        members={editable ? members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) })) : undefined}
        people={editable ? people : undefined}
        activities={activities.map((a) => ({ id: a.id, label: a.title }))}
        placeholder="Search this trip"
      />
      <TripMap
        key={query}
        src={`/api/trips/${slug}/geojson${query ? `?${query}` : ""}`}
        theme={mapThemeOf(getTheme(trip.themeKey))}
        narrowed={filterIsActive(filter)}
        below={
          editable ? (
            <p className="text-sm flex flex-wrap items-center gap-3">
              <ButtonLink href={`/trips/${slug}/place`} size="sm" variant="secondary" data-testid="open-place">Place photos</ButtonLink>
              <span className="text-muted">
                {waiting > 0 ? `${waiting} photograph${waiting === 1 ? " has" : "s have"} no place on this trip, or only a guessed one.` : "Something in the wrong spot? Move it where it belongs."}
              </span>
            </p>
          ) : undefined
        }
      />
    </div>
  );
}
