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
  const page = await tripPhotoPage(trip.id, { readyOnly: true });
  return <SharedGallery photos={page.photos.map((p) => toGridPhoto(p))} more={{ url: `/api/trips/${trip.slug}/photos?view=share`, nextCursor: page.nextCursor, total: page.total }} />;
}
