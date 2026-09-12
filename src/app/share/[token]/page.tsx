import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSharedTrip } from "@/lib/share/queries";
import { photoCardSelect } from "@/lib/photos/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ActivityCard } from "@/components/activities/ActivityCard";
import { NOT_TRASHED } from "@/lib/photos/trash";

export default async function SharedOverviewPage({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const [latest, activities] = await Promise.all([
    db.photo.findMany({ where: { tripId: trip.id, ...NOT_TRASHED, status: "READY" }, orderBy: [{ takenAt: "desc" }], take: 10, select: photoCardSelect }),
    db.activity.findMany({ where: { tripId: trip.id }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  return (
    <div className="space-y-8">
      <section>
        <h2 className="font-display text-xl font-semibold mb-3">Latest photos</h2>
        <PhotoGrid photos={latest.map((p) => toGridPhoto(p))} />
      </section>
      {activities.length > 0 && (
        <section>
          <h2 className="font-display text-xl font-semibold mb-3">Activities</h2>
          <div className="space-y-4">
            {activities.map((a) => (
              <ActivityCard key={a.id} activity={a} tripSlug={trip.slug} timezone={trip.timezone} hrefBase={`/share/${token}/activities`} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
