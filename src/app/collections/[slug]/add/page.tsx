import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableCollection } from "@/lib/collections/access";
import { candidatePhotoPage } from "@/lib/photos/page";
import { parsePickerFilter } from "@/lib/photos/picker-filter";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { AddPhotosPicker } from "@/components/collections/AddPhotosPicker";
import { peopleInPhotos } from "@/lib/people/in-photos";

export const metadata = { title: "Add photos" };

/**
 * Members pick photographs already in the album for this collection: search by words, by when and where they were
 * taken, or for the ones nothing has claimed yet; tick the ones that belong and add them in one go. Photographs
 * already in the collection are never offered.
 */
export default async function AddPhotosPage({ params, searchParams }: PageProps<"/collections/[slug]/add">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/add`);
  if (!editable) redirect(`/collections/${slug}`);
  const filter = parsePickerFilter(await searchParams);
  // Only the trip the filter already names, so the page does not carry a list of every trip there has ever been.
  const [page, named, members, people] = await Promise.all([
    candidatePhotoPage({ kind: "collection", id: collection.id }, filter),
    filter.trip && filter.trip !== "none" ? db.trip.findUnique({ where: { id: filter.trip }, select: { id: true, title: true } }) : Promise.resolve(null),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(),
  ]);
  const initialTrip = filter.trip === "none" ? { id: "none", title: "Without a trip" } : named;
  return (
    <AddPhotosPicker
      destination={{ kind: "collection", id: collection.id, slug, title: collection.title }}
      initialTrip={initialTrip}
      filter={filter}
      members={members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) }))}
      people={people}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
    />
  );
}
