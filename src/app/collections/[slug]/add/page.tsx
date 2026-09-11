import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableCollection } from "@/lib/collections/access";
import { candidatePhotoPage } from "@/lib/photos/page";
import { toGridPhoto } from "@/components/photos/toGrid";
import { AddPhotosPicker } from "@/components/collections/AddPhotosPicker";

export const metadata = { title: "Add photos" };

/**
 * Members pick photos already in the album for this collection: filter by trip or a word, tick the ones that
 * belong, and add them in one go. Photos already in the collection are not offered.
 */
export default async function AddPhotosPage({ params, searchParams }: PageProps<"/collections/[slug]/add">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/add`);
  if (!editable) redirect(`/collections/${slug}`);
  const sp = await searchParams;
  const trip = typeof sp.trip === "string" && sp.trip ? sp.trip : null;
  const q = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim().slice(0, 100) : null;
  const [page, trips] = await Promise.all([
    candidatePhotoPage({ excludeCollectionId: collection.id, trip, q }),
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
  ]);
  return (
    <AddPhotosPicker
      collection={{ id: collection.id, slug, title: collection.title }}
      trips={trips}
      filter={{ trip, q }}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
    />
  );
}
