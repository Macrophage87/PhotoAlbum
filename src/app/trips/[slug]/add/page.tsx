import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { candidatePhotoPage } from "@/lib/photos/page";
import { parsePickerFilter } from "@/lib/photos/picker-filter";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { AddPhotosPicker } from "@/components/collections/AddPhotosPicker";
import { peopleInPhotos } from "@/lib/people/in-photos";

export const metadata = { title: "Put photos on this trip" };

/**
 * Photographs that are already in the album, put onto this trip.
 *
 * The album files uploads onto a trip by the date they were taken, which is right for a camera and wrong for
 * everything else — a scan of a print, a photograph a cousin sent afterwards, anything whose file lost its date.
 * Those sit in the album with nothing claiming them, and this is how they are gathered up: search for them by
 * words, by when or where they were taken, or simply ask for the ones in no trip and no collection.
 */
export default async function AddToTripPage({ params, searchParams }: PageProps<"/trips/[slug]/add">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/add`);
  if (!editable) redirect(`/trips/${slug}`);
  const filter = parsePickerFilter(await searchParams);
  const [page, members, people] = await Promise.all([
    candidatePhotoPage({ kind: "trip", id: trip.id }, filter),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(),
  ]);
  return (
    <AddPhotosPicker
      destination={{ kind: "trip", id: trip.id, slug, title: trip.title }}
      initialTrip={null}
      filter={filter}
      members={members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) }))}
      people={people}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
    />
  );
}
