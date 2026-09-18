import Link from "next/link";
import { loadViewableTrip } from "@/lib/trips/access";
import { getViewer } from "@/lib/auth/viewer";
import { photoFavourites } from "@/lib/favourites/queries";
import { tripPhotoPage } from "@/lib/photos/page";
import { TripGallery } from "@/components/photos/TripGallery";
import { db } from "@/lib/db";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { ButtonLink } from "@/components/ui";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { describeCount, filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";
import { dateColumnToDay } from "@/lib/time/local-day";
import { peopleInPhotos } from "@/lib/people/in-photos";

export default async function TripPhotosPage({ params, searchParams }: PageProps<"/trips/[slug]/photos">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { trip, editable, owns } = await loadViewableTrip(slug, `/trips/${slug}/photos`);
  // Who uploaded what is members-only, so an anonymous visitor never sees the member list nor filters by it.
  const filter = parseGalleryFilter(sp, { member: editable });
  const [page, activities, members, people] = await Promise.all([
    tripPhotoPage(trip.id, { filter, viewerId: editable ? (await getViewer()).user?.id ?? null : null }),
    db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }),
    editable ? db.user.findMany({ where: { photos: { some: { tripId: trip.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    editable ? peopleInPhotos({ tripId: trip.id }) : Promise.resolve([]),
  ]);
  const photos = page.photos;
  const favourites = await photoFavourites(photos.map((p) => p.id), await getViewer());
  const query = filterQuery(filter);
  // Paging keeps the narrowing: the next page of a search is the next page of that same search.
  const moreUrl = `/api/trips/${trip.slug}/photos${query ? `?${query}` : ""}`;
  const active = filterIsActive(filter);
  // What the last tidy-up did, carried in the address so it survives the page being rebuilt around a shorter grid.
  const removed = typeof sp.removed === "string" ? Number(sp.removed) : NaN;
  const notYours = typeof sp.notyours === "string" ? Number(sp.notyours) : 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {active ? describeCount(page.total, trip._count.photos, true) : `${page.total} photo${page.total === 1 ? "" : "s"}`}
        </h2>
        <div className="flex items-center gap-2">
          {owns && <ButtonLink href={`/trips/${slug}/cover`} size="sm" variant="secondary">Cover photo</ButtonLink>}
          {editable && <ButtonLink href={`/trips/${slug}/add`} size="sm" variant="secondary">Add existing photos</ButtonLink>}
          {editable && <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload photos</ButtonLink>}
        </div>
      </div>
      {Number.isFinite(removed) && (
        <p role="status" className="text-sm rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 p-3">
          {removed} taken off this trip{notYours ? `, ${notYours} not yours to change` : ""}. {removed === 1 ? "It is" : "They are"} still in the album, under{" "}
          <Link href="/photos" className="underline underline-offset-2">photos without a trip</Link>.
        </p>
      )}
      <GalleryFilters
        filter={filter}
        action={`/trips/${slug}/photos`}
        members={editable ? members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) })) : undefined}
        people={editable ? people : undefined}
        activities={activities.map((a) => ({ id: a.id, label: a.title }))}
        placeholder="Search this trip"
      />
      {active && page.total === 0 && (
        <p className="text-muted text-sm" data-testid="no-matches">Nothing here matches that. Try fewer words, or clear the filters.</p>
      )}
      {editable && <YouTubeAddForm tripId={trip.id} defaultDate={dateColumnToDay(trip.startDate)} />}
      <TripGallery tripSlug={slug} key={`${moreUrl}:${page.total}:${photos[0]?.id ?? ""}:${photos[photos.length - 1]?.id ?? ""}`} photos={photos.map((p) => toGridPhoto(p, null, editable, favourites.get(p.id)))} more={{ url: moreUrl, nextCursor: page.nextCursor, total: page.total }} activities={activities} editable={editable} emptyMessage={editable ? "No photos yet. Upload some to get started." : "No photos yet."} />
    </div>
  );
}
