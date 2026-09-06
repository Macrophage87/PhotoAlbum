import { requireUser, getViewer } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripForm } from "@/components/trips/TripForm";
import { createTrip } from "./actions";
import { localDayInZone } from "@/lib/time/local-day";

export const metadata = { title: "New trip" };

export default async function NewTripPage() {
  await requireUser("/trips/new");
  const viewer = await getViewer();
  const defaultTimezone = "America/New_York";
  const today = localDayInZone(new Date(), defaultTimezone);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-2xl">
        <h1 className="font-display text-3xl font-semibold mb-6">New trip</h1>
        <TripForm action={createTrip} submitLabel="Create trip" initial={{ title: "", description: "", startDate: today, endDate: today, timezone: defaultTimezone, themeKey: "default" }} />
      </Container>
    </AppShell>
  );
}
