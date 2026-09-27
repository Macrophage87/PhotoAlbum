import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { db } from "@/lib/db";
import { requireTripOwnerPage } from "@/lib/trips/access";
import { TrackImporter } from "@/components/tracks/TrackImporter";
import { Card, ConfirmSubmitButton } from "@/components/ui";
import { deleteLooseTrack } from "./actions";

export default async function ImportPage({ params }: PageProps<"/trips/[slug]/import">) {
  const { slug } = await params;
  const { trip } = await requireTripOwnerPage(slug, `/trips/${slug}/import`);
  // Tracks no activity holds: Google traces, and one an activity left behind when it was deleted without it. An
  // activity's own track is deleted with the activity; these have nowhere else to be deleted from.
  const loose = await db.track.findMany({ where: { tripId: trip.id, activity: null }, select: { id: true, name: true, source: true, startTime: true, endTime: true, pointCount: true }, orderBy: { startTime: "asc" } });
  const when = (d: Date) => format(new TZDate(d, trip.timezone), "MMM d, h:mm a");
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="font-display text-xl font-semibold">Import tracks</h2>
        <p className="text-muted mt-1">Add GPS tracks from a watch, bike computer, phone app, or your Google location history.</p>
      </div>
      <TrackImporter tripId={trip.id} tripSlug={slug} />
      {loose.length > 0 && (
        <Card className="p-5 text-sm space-y-3" data-testid="loose-tracks">
          <div>
            <h3 className="font-medium">Tracks without an activity</h3>
            <p className="text-muted">Google traces, and tracks left behind when their activity was deleted. Deleting one takes back the places it gave photos, which are placed again from the trip&apos;s other tracks.</p>
          </div>
          <ul className="divide-y divide-border">
            {loose.map((t) => (
              <li key={t.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t.name}
                  <span className="text-muted"> · {t.source === "GOOGLE" ? "Google" : t.source} · {when(t.startTime)} to {when(t.endTime)} · {t.pointCount.toLocaleString("en-US")} pts</span>
                </span>
                <form action={deleteLooseTrack.bind(null, slug, t.id)}>
                  <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Delete the track "${t.name}"? This cannot be undone.`}>
                    Delete track
                  </ConfirmSubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}
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
          <p className="text-muted mt-2">
            Each import adds its own trace for each day, so several people&apos;s exports can sit side by side. To refresh a trace instead, check <em>Replace my earlier Google traces for these days</em>: traces imported with an earlier version placed photos only near the start or end of each place you stopped at, and importing the export again that way also places photos taken while you were there.
          </p>
        </div>
      </Card>
    </div>
  );
}
