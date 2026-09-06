import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { listTripPhotos } from "@/lib/photos/queries";
import { TripGallery } from "@/components/photos/TripGallery";
import { db } from "@/lib/db";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ButtonLink } from "@/components/ui";

export default async function TripPhotosPage({ params }: PageProps<"/trips/[slug]/photos">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const editable = canEditTrip(viewer);
  const [photos, activities, trips] = await Promise.all([
    listTripPhotos(trip.id),
    editable ? db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.trip.findMany({ where: { id: { not: trip.id } }, orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
        </h2>
        {editable && <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload photos</ButtonLink>}
      </div>
      <TripGallery photos={photos.map((p) => toGridPhoto(p))} activities={activities} trips={trips} editable={editable} emptyMessage={editable ? "No photos yet. Upload some to get started." : "No photos yet."} />
    </div>
  );
}
