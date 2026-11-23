import { loadViewableTrip } from "@/lib/trips/access";
import { tripSlides } from "@/lib/photos/slideshow";
import { Slideshow } from "@/components/slideshow/Slideshow";

export const metadata = { title: "Slideshow" };

export default async function TripSlideshowPage({ params }: PageProps<"/trips/[slug]/slideshow">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/slideshow`);
  const slides = await tripSlides(trip.id, editable);
  return <Slideshow title={trip.title} slides={slides} closeHref={`/trips/${slug}`} />;
}
