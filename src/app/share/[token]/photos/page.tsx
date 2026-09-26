import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { tripPhotoPage } from "@/lib/photos/page";
import { SharedGallery } from "@/components/photos/SharedGallery";
import { toGridPhoto } from "@/components/photos/toGrid";

export default async function SharedPhotosPage({ params }: PageProps<"/share/[token]/photos">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  // Finished items only, asked of the database so the count and the next page agree with what is shown.
  // In the order the day happened: favourites first would give away what the family hearted (VISITOR_PHOTO_SORTS).
  const page = await tripPhotoPage(trip.id, { readyOnly: true, order: "taken" });
  return <SharedGallery photos={page.photos.map((p) => toGridPhoto(p))} more={{ url: `/api/trips/${trip.slug}/photos?view=share&order=oldest`, nextCursor: page.nextCursor, total: page.total }} />;
}
