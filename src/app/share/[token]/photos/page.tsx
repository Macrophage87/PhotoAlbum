import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { tripPhotoPage } from "@/lib/photos/page";
import { SharedGallery } from "@/components/photos/SharedGallery";
import { toGridPhoto } from "@/components/photos/toGrid";

export default async function SharedPhotosPage({ params }: PageProps<"/share/[token]/photos">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const page = await tripPhotoPage(trip.id);
  return <SharedGallery photos={page.photos.filter((p) => p.status === "READY").map((p) => toGridPhoto(p))} more={{ url: `/api/trips/${trip.slug}/photos`, nextCursor: page.nextCursor, total: page.total }} />;
}
