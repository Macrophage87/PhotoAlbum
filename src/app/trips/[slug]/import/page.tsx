import { requireTripOwnerPage } from "@/lib/trips/access";
import { TrackImporter } from "@/components/tracks/TrackImporter";
import { Card } from "@/components/ui";

export default async function ImportPage({ params }: PageProps<"/trips/[slug]/import">) {
  const { slug } = await params;
  const { trip } = await requireTripOwnerPage(slug, `/trips/${slug}/import`);
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="font-display text-xl font-semibold">Import tracks</h2>
        <p className="text-muted mt-1">Add GPS tracks from a watch, bike computer, phone app, or your Google location history.</p>
      </div>
      <TrackImporter tripId={trip.id} tripSlug={slug} />
      <Card className="p-5 text-sm space-y-3">
        <div>
          <h3 className="font-medium">GPX and FIT files</h3>
          <p className="text-muted">Export from Garmin Connect, Strava, Wahoo, Komoot, AllTrails and most apps. Each file becomes an activity with its route, distance, time, elevation and any heart-rate, cadence or power data.</p>
        </div>
        <div>
          <h3 className="font-medium">Google location history</h3>
          <p className="text-muted">
            Google no longer offers a live connection, but you can export your Timeline as a file. On your phone open Google Maps → your profile → <em>Your Timeline</em> → <em>⋯</em> → <em>Location and privacy settings</em> → <em>Export Timeline data</em>, which produces <code>Timeline.json</code>. Older Google Takeout exports (<code>Records.json</code> or the monthly <code>Semantic Location History</code> files) also work.
            Only points between {trip.startDate.toISOString().slice(0, 10)} and {trip.endDate.toISOString().slice(0, 10)} are imported, one trace per day, so it&apos;s safe to upload the whole export.
          </p>
        </div>
      </Card>
    </div>
  );
}
