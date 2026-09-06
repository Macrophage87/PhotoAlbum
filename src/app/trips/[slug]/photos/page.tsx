import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { listTripPhotos } from "@/lib/photos/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ButtonLink } from "@/components/ui";

export default async function TripPhotosPage({ params }: PageProps<"/trips/[slug]/photos">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const editable = canEditTrip(viewer);
  const photos = await listTripPhotos(trip.id);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
        </h2>
        {editable && <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload photos</ButtonLink>}
      </div>
      <PhotoGrid photos={photos.map((p) => toGridPhoto(p))} showDetailLink={editable} emptyMessage={editable ? "No photos yet. Upload some to get started." : "No photos yet."} />
    </div>
  );
}
