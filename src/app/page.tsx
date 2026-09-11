import { getViewer } from "@/lib/auth/viewer";
import { coverFor, listVisibleTrips } from "@/lib/trips/queries";
import { collectionCoverFor, listVisibleCollections } from "@/lib/collections/queries";
import { CollectionCard } from "@/components/collections/CollectionCard";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripCard } from "@/components/trips/TripCard";
import { ButtonLink } from "@/components/ui";

export default async function HomePage() {
  const viewer = await getViewer();
  const trips = await listVisibleTrips(viewer);
  const collections = await listVisibleCollections(viewer);
  const [covers, collectionCovers] = await Promise.all([Promise.all(trips.map((t) => coverFor(t))), Promise.all(collections.map((c) => collectionCoverFor(c)))]);
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
        {(member || collections.length > 0) && (
          <section className="mt-14">
            <div className="flex items-end justify-between gap-4 mb-6">
              <div>
                <h2 className="font-display text-3xl font-semibold">Collections</h2>
                <p className="text-muted mt-1">{member ? "Photos gathered by theme, from any trip or none." : "Public collections from our family album."}</p>
              </div>
              {member && <ButtonLink href="/collections/new" variant="secondary">New collection</ButtonLink>}
            </div>
            {collections.length === 0 ? (
              <p className="text-muted">No collections yet. Make one for a person, a place, a year, or the dog.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {collections.map((c, i) => (
                  <CollectionCard key={c.id} collection={c} cover={collectionCovers[i]} showVisibility={member} />
                ))}
              </div>
            )}
          </section>
        )}
      </Container>
    </AppShell>
  );
}
