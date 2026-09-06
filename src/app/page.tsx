import { getViewer } from "@/lib/auth/viewer";
import { coverFor, listVisibleTrips } from "@/lib/trips/queries";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripCard } from "@/components/trips/TripCard";
import { ButtonLink } from "@/components/ui";

export default async function HomePage() {
  const viewer = await getViewer();
  const trips = await listVisibleTrips(viewer);
  const covers = await Promise.all(trips.map((t) => coverFor(t)));
  const member = viewer.kind === "user";

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-3xl font-semibold">Trips</h1>
            <p className="text-muted mt-1">{member ? "Everywhere we've been together." : "Public trips from our family album."}</p>
          </div>
          {member && <ButtonLink href="/trips/new">New trip</ButtonLink>}
        </div>
        {trips.length === 0 ? (
          <p className="text-muted">{member ? "No trips yet. Create the first one." : "Nothing public yet. Family members can sign in to see everything."}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {trips.map((t, i) => (
              <TripCard key={t.id} trip={t} cover={covers[i]} showVisibility={member} />
            ))}
          </div>
        )}
      </Container>
    </AppShell>
  );
}
