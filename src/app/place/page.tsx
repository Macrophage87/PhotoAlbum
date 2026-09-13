import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PlaceOnMap } from "@/components/map/PlaceOnMap";
import { unplacedForTray } from "@/lib/photos/unplaced";

export const metadata = { title: "Place photos" };

/**
 * Point at where a photograph was taken, for everything the album could not work out by itself. Scoped to one trip
 * with `?trip=<slug>`, which is the usual way to reach it: a trip's map knows what is still missing from it.
 */
export default async function PlacePhotosPage({ searchParams }: PageProps<"/place">) {
  const me = await requireUser("/place");
  const viewer = await getViewer();
  const sp = await searchParams;
  const slug = typeof sp.trip === "string" && sp.trip ? sp.trip : null;
  const trip = slug ? await db.trip.findUnique({ where: { slug }, select: { id: true, slug: true, title: true, themeKey: true } }) : null;
  const tray = await unplacedForTray(me, { tripId: trip?.id ?? null });

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">Place photos</h1>
            <p className="text-muted mt-1 text-sm">
              Photographs with no position, and the ones the helper only guessed at.{" "}
              {trip ? <Link href={`/trips/${trip.slug}/map`} className="text-primary hover:underline">Back to {trip.title}</Link> : <Link href="/map" className="text-primary hover:underline">Back to the map</Link>}
            </p>
          </div>
        </div>
        <PlaceOnMap
          src={trip ? `/api/trips/${trip.slug}/geojson` : "/api/map/geojson"}
          theme={mapThemeOf(getTheme(trip?.themeKey ?? "default"))}
          initial={tray}
          tripTitle={trip?.title ?? null}
        />
      </Container>
    </AppShell>
  );
}
