import Link from "next/link";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ButtonLink, Card } from "@/components/ui";
import { dateColumnToDay } from "@/lib/time/local-day";

export default async function TripOverviewPage({ params }: PageProps<"/trips/[slug]">) {
  const { slug } = await params;
  const { trip, editable } = await loadViewableTrip(slug);

  const [latest, trackAgg] = await Promise.all([
    db.photo.findMany({ where: { tripId: trip.id, status: "READY" }, orderBy: [{ takenAt: "desc" }], take: 10, select: photoCardSelect }),
    db.trackStats.aggregate({ where: { track: { tripId: trip.id, activity: { isNot: null } } }, _sum: { distanceM: true, elevGainM: true } }),
  ]);
  const days = Math.round((Date.parse(dateColumnToDay(trip.endDate)) - Date.parse(dateColumnToDay(trip.startDate))) / 86_400_000) + 1;
  const meters = trackAgg._sum?.distanceM ?? 0;
  const km = meters > 0 ? (meters / 1609.344).toFixed(0) : null;

  const stats: [string, string][] = [
    ["Days", String(days)],
    ["Photos", String(trip._count.photos)],
    ["Activities", String(trip._count.activities)],
    ...(km ? ([["Miles tracked", km]] as [string, string][]) : []),
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(([k, v]) => (
          <Card key={k} className="p-4">
            <div className="text-2xl font-semibold font-display">{v}</div>
            <div className="text-sm text-muted">{k}</div>
          </Card>
        ))}
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xl font-semibold">Latest photos</h2>
          <div className="flex gap-2">
            {editable && <ButtonLink href={`/upload?trip=${trip.slug}`} size="sm">Upload</ButtonLink>}
            <Link href={`/trips/${trip.slug}/photos`} className="text-sm text-primary underline-offset-2 hover:underline self-center">
              All photos →
            </Link>
          </div>
        </div>
        <PhotoGrid photos={latest.map((p) => toGridPhoto(p, null, editable))} showDetailLink={editable} emptyMessage={editable ? "No photos yet. Upload some to get started." : "No photos yet."} />
      </section>
    </div>
  );
}
