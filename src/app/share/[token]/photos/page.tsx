import { notFound } from "next/navigation";
import { getSharedTrip } from "@/lib/share/queries";
import { listTripPhotos } from "@/lib/photos/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";

export default async function SharedPhotosPage({ params }: PageProps<"/share/[token]/photos">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const photos = await listTripPhotos(trip.id);
  return <PhotoGrid photos={photos.filter((p) => p.status === "READY").map((p) => toGridPhoto(p))} showDetailLink={false} />;
}
