import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { loadViewableCollection } from "@/lib/collections/access";
import { FavouritesView, parseWho } from "@/components/favourites/FavouritesView";

/** This collection's favourites. Members only: somebody holding a share link has no favourites to show. */
export default async function CollectionFavouritesPage({ params, searchParams }: PageProps<"/collections/[slug]/favorites">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { collection } = await loadViewableCollection(slug);
  const viewer = await getViewer();
  if (viewer.kind !== "user") notFound();
  return <FavouritesView viewer={viewer} scope={{ collectionId: collection.id }} who={parseWho(sp.who)} base={`/collections/${slug}/favorites`} where="in this collection" />;
}
