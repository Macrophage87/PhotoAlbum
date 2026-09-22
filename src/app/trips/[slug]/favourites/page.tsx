import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { loadViewableTrip } from "@/lib/trips/access";
import { FavouritesView, parseWho } from "@/components/favourites/FavouritesView";

/** This trip's favourites. Members only: somebody holding a share link has no favourites to show. */
export default async function TripFavouritesPage({ params, searchParams }: PageProps<"/trips/[slug]/favourites">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { trip } = await loadViewableTrip(slug, `/trips/${slug}/favourites`);
  const viewer = await getViewer();
  if (viewer.kind !== "user") notFound();
  return <FavouritesView viewer={viewer} scope={{ tripId: trip.id }} who={parseWho(sp.who)} base={`/trips/${slug}/favourites`} where="in this trip" />;
}
