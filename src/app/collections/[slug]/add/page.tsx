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
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(sp.from), to = day(sp.to);
  const [page, trips] = await Promise.all([
    candidatePhotoPage({ excludeCollectionId: collection.id, trip, q, from, to }),
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
  ]);
  return (
    <AddPhotosPicker
      collection={{ id: collection.id, slug, title: collection.title }}
      trips={trips}
      filter={{ trip, q, from, to }}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
    />
  );
}
