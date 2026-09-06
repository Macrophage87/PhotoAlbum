import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripMap } from "@/components/map/TripMap";

export const metadata = { title: "Map" };

export default async function GlobalMapPage() {
  const viewer = await getViewer();
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <h1 className="font-display text-3xl font-semibold">Map</h1>
        <TripMap src="/api/map/geojson" theme={mapThemeOf(getTheme("default"))} showDetailLink={canEditTrip(viewer)} showTripList />
      </Container>
    </AppShell>
  );
}
