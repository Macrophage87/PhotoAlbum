import Link from "next/link";
import { loadViewableTrip } from "@/lib/trips/access";
import { requireUser } from "@/lib/auth/viewer";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { db } from "@/lib/db";
import { buildMapPayload } from "@/lib/map/geojson";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { PlaceStudio } from "@/components/map/PlaceStudio";
import { uploaderLabel } from "@/components/photos/toGrid";
import { filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";
import { peopleInPhotos } from "@/lib/people/in-photos";
import { isAdmin } from "@/lib/auth/ownership";
import { parsePlacingShow, photosForPlacing } from "@/lib/photos/placing";

export const metadata = { title: "Place photos" };

/**
 * Where a trip's photographs are put on the map by hand: choose them on one half of the screen, point at the spot
 * on the other. Members only, and each member places their own; an admin can place anybody's.
 */
export default async function PlaceTripPhotosPage({ params, searchParams }: PageProps<"/trips/[slug]/place">) {
  const { slug } = await params;
  const sp = await searchParams;
  const path = `/trips/${slug}/place`;
  const { viewer, trip } = await loadViewableTrip(slug, path);
  const me = await requireUser(path);
  const filter = parseGalleryFilter(sp, { member: true });
  const show = parsePlacingShow(sp.show);
  const [{ photos, total }, map, activities, members, people] = await Promise.all([
    photosForPlacing(me, { id: trip.id, timezone: trip.timezone }, filter, show),
    // The trip's tracks go under the photographs: a line of where the walk went is the best clue to where a
    // picture on it was taken.
    buildMapPayload(viewer, trip.id),
    db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }),
    isAdmin(me) ? db.user.findMany({ where: { photos: { some: { tripId: trip.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    peopleInPhotos({ tripId: trip.id }),
  ]);
  const query = filterQuery(filter);
  const showHref = (value: "unplaced" | "all") => {
    const p = new URLSearchParams(query);
    if (value === "all") p.set("show", "all");
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };
  const tab = (value: "unplaced" | "all", label: string) => (
    <Link
      href={showHref(value)}
      aria-current={show === value ? "page" : undefined}
      data-testid={`place-show-${value}`}
      className={`px-3 py-2 rounded-theme text-sm ${show === value ? "bg-primary text-primary-fg" : "border border-border hover:bg-surface-alt"}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-semibold">Place photos</h2>
        <Link href="/guide#placing" className="text-sm text-primary underline underline-offset-2">How this works</Link>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Which photos">
        {tab("unplaced", "Not placed yet")}
        {tab("all", "All photos")}
      </nav>
      <GalleryFilters
        filter={filter}
        action={path}
        members={members.length ? members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) })) : undefined}
        people={people}
        activities={activities.map((a) => ({ id: a.id, label: a.title }))}
        placeholder="Search this trip"
        hidden={show === "all" ? { show: "all" } : undefined}
      />
      {!isAdmin(me) && <p className="text-xs text-muted">Only the photos you added are here. An admin can place anybody&apos;s.</p>}
      {photos.length === 0 && (
        <p className="text-sm rounded-theme border border-border bg-surface p-3" data-testid="place-none">
          {filterIsActive(filter)
            ? "Nothing matches that. Clear the search to see them all."
            : show === "unplaced"
              ? <>Everything you added here already has a place. To move one that is in the wrong spot, choose <Link href={showHref("all")} className="text-primary underline">All photos</Link>.</>
              : "There are no photos of yours on this trip yet."}
        </p>
      )}
      {/* Keyed by what is listed, so a new search starts a fresh screen rather than keeping the old one's choices. */}
      <PlaceStudio key={`${show}:${query}`} photos={photos} total={total} theme={mapThemeOf(getTheme(trip.themeKey))} tracks={map.tracks} bounds={map.bounds} />
    </div>
  );
}
