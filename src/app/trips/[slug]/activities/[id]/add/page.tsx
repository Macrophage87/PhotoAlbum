import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { requireUser } from "@/lib/auth/viewer";
import { candidatePhotoPage } from "@/lib/photos/page";
import { parsePickerFilter } from "@/lib/photos/picker-filter";
import { activityWindow } from "@/lib/photos/in-window";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { AddPhotosPicker } from "@/components/collections/AddPhotosPicker";
import { TakeWindow } from "@/components/photos/TakeWindow";
import { attachActivityWindow } from "@/app/photos/attach-actions";
import { peopleInPhotos } from "@/lib/people/in-photos";
import { formatLocalTime } from "@/lib/time/format";

export const metadata = { title: "Put photos on this activity" };

/**
 * Photographs already in the album, put on one activity: everything taken while it was happening in one press, or
 * any of them picked out of the whole album with the same questions the trip's own picker asks.
 */
export default async function AddToActivityPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]/add">) {
  const { slug, id } = await params;
  const path = `/trips/${slug}/activities/${id}/add`;
  const { trip, editable } = await loadViewableTrip(slug, path);
  if (!editable) redirect(`/trips/${slug}/activities/${id}`);
  const me = await requireUser(path);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, title: true, tripId: true, startTime: true, endTime: true } });
  if (!activity) notFound();
  const filter = parsePickerFilter(await searchParams);
  const [page, members, people, during] = await Promise.all([
    candidatePhotoPage({ kind: "activity", id: activity.id }, filter),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(),
    activityWindow(me, activity),
  ]);
  const when = `${formatLocalTime(activity.startTime, { timezone: trip.timezone })} – ${formatLocalTime(activity.endTime, { timezone: trip.timezone })}`;
  const n = during.ids.length;
  return (
    <AddPhotosPicker
      destination={{ kind: "activity", id: activity.id, slug, title: activity.title, tripId: activity.tripId }}
      initialTrip={null}
      filter={filter}
      members={members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) }))}
      people={people}
      initial={{ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.total }}
      extra={
        <TakeWindow
          count={n}
          elsewhere={during.elsewhere}
          label={`Add all ${n} photo${n === 1 ? "" : "s"} taken during it (${when})`}
          confirmText={`Put all ${n} photo${n === 1 ? "" : "s"} taken between ${when} on ${activity.title}?`}
          doneHref={`/trips/${slug}/activities/${activity.id}`}
          action={attachActivityWindow.bind(null, activity.id)}
          testId="activity-window"
        />
      }
    />
  );
}
