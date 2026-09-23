import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PlaceOnMap } from "@/components/map/PlaceOnMap";
import { unplacedForTray } from "@/lib/photos/unplaced";

export const metadata = { title: "Place photos" };

/**
 * Point at where a photograph was taken, for everything the album could not work out by itself, across every trip.
 * A trip's own photographs have a better screen, on the trip, which can search them and move ones already placed;
 * `?trip=<slug>`, the old way here from a trip, goes there.
 */
export default async function PlacePhotosPage({ searchParams }: PageProps<"/place">) {
  const me = await requireUser("/place");
  const viewer = await getViewer();
  const sp = await searchParams;
  const slug = typeof sp.trip === "string" && sp.trip ? sp.trip : null;
  if (slug && (await db.trip.findUnique({ where: { slug }, select: { id: true } }))) redirect(`/trips/${slug}/place`);
  const tray = await unplacedForTray(me, { tripId: null });

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">Place photos</h1>
            <p className="text-muted mt-1 text-sm">
              Photographs with no position, and the ones the helper only guessed at. On a phone, or to move ones that
              are already placed, open the trip&apos;s map and press <strong>Place photos</strong>.{" "}
              <Link href="/map" className="text-primary hover:underline">Back to the map</Link>
            </p>
          </div>
        </div>
        <PlaceOnMap src="/api/map/geojson" theme={mapThemeOf(getTheme("default"))} initial={tray} tripTitle={null} />
      </Container>
    </AppShell>
  );
}
