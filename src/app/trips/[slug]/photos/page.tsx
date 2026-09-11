import { loadViewableTrip } from "@/lib/trips/access";
import { tripPhotoPage } from "@/lib/photos/page";
import { TripGallery } from "@/components/photos/TripGallery";
import { db } from "@/lib/db";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { Button, ButtonLink } from "@/components/ui";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";
import { dateColumnToDay } from "@/lib/time/local-day";

export default async function TripPhotosPage({ params, searchParams }: PageProps<"/trips/[slug]/photos">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/photos`);
  // The uploader filter is a members-only control; anonymous requests never see the member list.
  const uploaderId = editable && typeof sp.uploader === "string" && sp.uploader ? sp.uploader : undefined;
  const [page, activities, trips, collections, members] = await Promise.all([
    tripPhotoPage(trip.id, { uploaderId }),
    editable ? db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.trip.findMany({ where: { id: { not: trip.id } }, orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.user.findMany({ where: { photos: { some: { tripId: trip.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
  ]);
  const photos = page.photos;
  const moreUrl = `/api/trips/${trip.slug}/photos${uploaderId ? `?uploader=${encodeURIComponent(uploaderId)}` : ""}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {page.total} photo{page.total === 1 ? "" : "s"}
        </h2>
        <div className="flex items-center gap-2">
          {editable && members.length > 1 && (
            <form method="get" className="flex items-center gap-2 text-sm">
              <label htmlFor="uploader" className="text-muted">Uploaded by</label>
              <select id="uploader" name="uploader" defaultValue={uploaderId ?? ""} className="h-8 rounded-theme border border-border bg-surface px-2 text-sm">
                <option value="">Anyone</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{uploaderLabel(m.name, m.email)}</option>
                ))}
              </select>
              <Button type="submit" variant="ghost" size="sm">Filter</Button>
            </form>
          )}
          {editable && <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload photos</ButtonLink>}
        </div>
      </div>
      {editable && <YouTubeAddForm tripId={trip.id} defaultDate={dateColumnToDay(trip.startDate)} />}
      <TripGallery key={`${moreUrl}:${page.total}:${photos[0]?.id ?? ""}:${photos[photos.length - 1]?.id ?? ""}`} photos={photos.map((p) => toGridPhoto(p, null, editable))} more={{ url: moreUrl, nextCursor: page.nextCursor, total: page.total }} activities={activities} trips={trips} collections={collections} editable={editable} emptyMessage={editable ? "No photos yet. Upload some to get started." : "No photos yet."} />
    </div>
  );
}
