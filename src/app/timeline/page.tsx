import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { listVisibleTrips } from "@/lib/trips/queries";
import { tripTimeline } from "@/lib/timeline/queries";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Timeline } from "@/components/timeline/Timeline";
import { TripTheme } from "@/themes/TripTheme";

export const metadata = { title: "Timeline" };

export default async function GlobalTimelinePage() {
  const viewer = await getViewer();
  const trips = await listVisibleTrips(viewer);
  const groups = await Promise.all(trips.map((t) => tripTimeline(t.id, t.timezone)));
  const editable = canEditTrip(viewer);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <h1 className="font-display text-3xl font-semibold mb-8">Timeline</h1>
        {trips.length === 0 && <p className="text-muted">Nothing to show yet.</p>}
        <div className="space-y-12">
          {trips.map((trip, i) => (
            <TripTheme key={trip.id} themeKey={trip.themeKey} className="rounded-theme border border-border bg-bg text-text font-body p-5 sm:p-6">
              <div className="mb-4">
                <h2 className="font-display text-2xl font-semibold">
                  <Link href={`/trips/${trip.slug}`} className="hover:underline underline-offset-2">
                    {trip.title}
                  </Link>
                </h2>
                <p className="text-muted text-sm">{formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate))}</p>
              </div>
              <Timeline groups={groups[i]} tripSlug={trip.slug} timezone={trip.timezone} showDetailLink={editable} idPrefix={`t-${trip.slug}`} />
            </TripTheme>
          ))}
        </div>
      </Container>
    </AppShell>
  );
}
