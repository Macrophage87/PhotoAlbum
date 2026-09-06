import { requireUser, getViewer } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripForm } from "@/components/trips/TripForm";
import { createTrip } from "./actions";

export const metadata = { title: "New trip" };

export default async function NewTripPage() {
  await requireUser("/trips/new");
  const viewer = await getViewer();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-2xl">
        <h1 className="font-display text-3xl font-semibold mb-6">New trip</h1>
        <TripForm action={createTrip} submitLabel="Create trip" initial={{ title: "", description: "", startDate: today, endDate: today, timezone: "America/New_York", themeKey: "default" }} />
      </Container>
    </AppShell>
  );
}
