import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { tripTimeline } from "@/lib/timeline/queries";
import { uploaderLabel } from "@/components/photos/toGrid";
import { describeCount, parseGalleryFilter } from "@/lib/photos/filters";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { Timeline } from "@/components/timeline/Timeline";
import { ButtonLink } from "@/components/ui";
import { SelectionProvider } from "@/components/photos/selection";
import { peopleInPhotos } from "@/lib/people/in-photos";

/**
 * What a trip opens on: the days it was, in order.
 *
 * A family album is remembered as a sequence of days rather than as a grid of files, so the timeline is the trip
 * itself and everything else is a way of looking at it differently. Asking it a question narrows it where it
 * stands, which keeps each answer among the dates around it.
 */
export default async function TripTimelinePage({ params, searchParams }: PageProps<"/trips/[slug]">) {
  const { slug } = await params;
  const sp = await searchParams;
  const { trip, editable } = await loadViewableTrip(slug);
  // Who uploaded what is members-only, so an anonymous visitor never sees the member list nor narrows by it.
  const filter = parseGalleryFilter(sp, { member: editable });
  const [{ groups, matched, total, active }, activities, members, people] = await Promise.all([
    tripTimeline(trip.id, trip.timezone, filter),
    db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }),
    editable ? db.user.findMany({ where: { photos: { some: { tripId: trip.id } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    editable ? peopleInPhotos({ tripId: trip.id }) : Promise.resolve([]),
  ]);
  const timeline = (
    <div className="space-y-4">
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload photos</ButtonLink>
          <ButtonLink href={`/trips/${slug}/add`} size="sm" variant="secondary">Add existing photos</ButtonLink>
        </div>
      )}
      <GalleryFilters
        filter={filter}
        action={`/trips/${slug}`}
        members={editable ? members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) })) : undefined}
        people={editable ? people : undefined}
        activities={activities.map((a) => ({ id: a.id, label: a.title }))}
        placeholder="Search this trip"
      />
      <p className="text-sm text-muted" data-testid="timeline-count">{active ? describeCount(matched, total, true) : `${total} photo${total === 1 ? "" : "s"}`}</p>
      {active && matched === 0 ? (
        <p className="text-muted text-sm" data-testid="no-matches">Nothing here matches that. Try fewer words, or clear the search.</p>
      ) : (
        <Timeline groups={groups} tripSlug={slug} timezone={trip.timezone} member={editable} />
      )}
    </div>
  );
  // Members get the selection bar here: a wrong date is usually spotted on the timeline, and this is where a whole
  // day of them can be picked up and corrected at once.
  return editable ? <SelectionProvider>{timeline}</SelectionProvider> : timeline;
}
