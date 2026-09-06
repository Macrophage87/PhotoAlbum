import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { ActivityCard } from "@/components/activities/ActivityCard";
import { ButtonLink } from "@/components/ui";

export default async function ActivitiesPage({ params }: PageProps<"/trips/[slug]/activities">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const editable = canEditTrip(viewer);
  const activities = await db.activity.findMany({
    where: { tripId: trip.id },
    orderBy: { startTime: "asc" },
    include: { track: { select: { simplified: true, stats: true } } },
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
      {activities.length === 0 ? (
        <p className="text-muted text-sm">{editable ? "No activities yet. Add one by hand, or import a GPX or FIT file to create one with its track and stats." : "No activities yet."}</p>
      ) : (
        <div className="space-y-4">
          {activities.map((a) => (
            <ActivityCard key={a.id} activity={a} tripSlug={slug} timezone={trip.timezone} />
          ))}
        </div>
      )}
    </div>
  );
}
