import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { candidatePhotoPage } from "@/lib/photos/page";
import { parsePickerFilter } from "@/lib/photos/picker-filter";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { AddPhotosPicker } from "@/components/collections/AddPhotosPicker";
import { peopleInPhotos } from "@/lib/people/in-photos";
import { requireUser } from "@/lib/auth/viewer";
import { tripWindow } from "@/lib/photos/in-window";
import { TakeWindow } from "@/components/photos/TakeWindow";
import { putTripWindow } from "@/app/photos/attach-actions";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";

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
  const me = await requireUser(`/trips/${slug}/add`);
  const filter = parsePickerFilter(await searchParams);
  const [page, members, people, during] = await Promise.all([
    candidatePhotoPage({ kind: "trip", id: trip.id }, filter),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(),
    tripWindow(me, trip),
  ]);
  const days = formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate));
  const n = during.ids.length;
  return (
    <AddPhotosPicker
      destination={{ kind: "trip", id: trip.id, slug, title: trip.title }}
      initialTrip={null}
      filter={filter}
      members={members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) }))}
      people={people}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
      extra={
        <TakeWindow
          count={n}
          elsewhere={during.elsewhere}
          label={`Add all ${n} photo${n === 1 ? "" : "s"} taken during the trip (${days}) that ${n === 1 ? "is" : "are"} on no trip`}
          confirmText={`Put all ${n} photo${n === 1 ? "" : "s"} taken ${days} that ${n === 1 ? "is" : "are"} on no trip onto ${trip.title}? Each goes onto the outing its time falls in, too.`}
          doneHref={`/trips/${slug}/photos`}
          action={putTripWindow.bind(null, trip.id)}
          testId="trip-window"
        />
      }
    />
  );
}
