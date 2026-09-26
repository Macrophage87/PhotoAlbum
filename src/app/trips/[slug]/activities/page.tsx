import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { ActivityCard } from "@/components/activities/ActivityCard";
import { ButtonLink } from "@/components/ui";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { DATE_SORTS, SORT_COOKIES, sortChoice } from "@/lib/sort-choice";
import { SortToggle } from "@/components/ui/SortToggle";

export default async function ActivitiesPage({ params, searchParams }: PageProps<"/trips/[slug]/activities">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug, `/trips/${slug}/activities`);
  // The order they happened in, unless this person has asked for the latest first.
  const sort = await sortChoice(await searchParams, SORT_COOKIES.activities, DATE_SORTS, "oldest");
  const activities = await db.activity.findMany({
    where: { tripId: trip.id },
    orderBy: { startTime: sort === "newest" ? "desc" : "asc" },
    include: { track: { select: { simplified: true, stats: true } }, _count: { select: { photos: { where: NOT_TRASHED } } } },
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">
          {activities.length} activit{activities.length === 1 ? "y" : "ies"}
        </h2>
        {editable && (
          <div className="flex gap-2">
            <ButtonLink href={`/trips/${slug}/import`} variant="secondary" size="sm">Import GPX / FIT</ButtonLink>
            <ButtonLink href={`/trips/${slug}/activities/new`} size="sm">Add activity</ButtonLink>
          </div>
        )}
      </div>
      {activities.length > 1 && (
        <SortToggle
          value={sort}
          options={[{ value: "oldest", label: "Oldest first" }, { value: "newest", label: "Newest first" }]}
          cookie={SORT_COOKIES.activities}
          label="Which way the activities are listed"
          testId="activities-order"
        />
      )}
      {activities.length === 0 ? (
        <p className="text-muted text-sm">{editable ? "No activities yet. Add one by hand, or import a GPX or FIT file to create one with its track and stats." : "No activities yet."}</p>
      ) : (
        <div className="space-y-4">
          {activities.map((a) => (
            <ActivityCard key={a.id} activity={{ ...a, photoCount: a._count.photos }} tripSlug={slug} timezone={trip.timezone} />
          ))}
        </div>
      )}
    </div>
  );
}
