import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { ContainerSearch } from "@/components/containers/ContainerSearch";
import { countVisibleTrips, coverFor, listVisibleTrips } from "@/lib/trips/queries";
import { collectionCoverFor, countVisibleCollections, listVisibleCollections } from "@/lib/collections/queries";
import { CollectionCard } from "@/components/collections/CollectionCard";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TripCard } from "@/components/trips/TripCard";
import { ButtonLink } from "@/components/ui";

/** How many cards a page of the front page holds. Enough to browse, few enough that a long history still loads. */
const PAGE = 24;

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const q = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim().slice(0, 100) : null;
  const page = Math.max(1, Number(typeof sp.page === "string" ? sp.page : 1) || 1);
  const skip = (page - 1) * PAGE;
  const [trips, collections, tripCount, collectionCount] = await Promise.all([
    listVisibleTrips(viewer, { q, take: PAGE, skip }),
    listVisibleCollections(viewer, { q, take: PAGE, skip }),
    countVisibleTrips(viewer, q),
    countVisibleCollections(viewer, q),
  ]);
  const [covers, collectionCovers] = await Promise.all([Promise.all(trips.map((t) => coverFor(t))), Promise.all(collections.map((c) => collectionCoverFor(c)))]);
  const member = viewer.kind === "user";
  const pages = Math.max(Math.ceil(tripCount / PAGE), Math.ceil(collectionCount / PAGE));
  const href = (n: number) => `/?${new URLSearchParams({ ...(q ? { q } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`;

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-3xl font-semibold">Trips</h1>
            <p className="text-muted mt-1">{q ? `${tripCount} trip${tripCount === 1 ? "" : "s"} matching “${q}”.` : member ? "Everywhere we've been together." : "Public trips from our family album."}</p>
          </div>
          {member && <ButtonLink href="/trips/new">New trip</ButtonLink>}
        </div>
        <div className="mb-6"><ContainerSearch initial={q ?? ""} /></div>
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
              <p className="text-muted">{q ? "No collections match that." : "No collections yet. Make one for a person, a place, a year, or the dog."}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {collections.map((c, i) => (
                  <CollectionCard key={c.id} collection={c} cover={collectionCovers[i]} showVisibility={member} />
                ))}
              </div>
            )}
          </section>
        )}
        {pages > 1 && (
          <nav className="mt-10 flex flex-wrap items-center gap-2 text-sm" aria-label="More pages">
            {page > 1 && <Link href={href(page - 1)} className="text-primary hover:underline">← Newer</Link>}
            <span className="text-muted">Page {page} of {pages}</span>
            {page < pages && <Link href={href(page + 1)} className="text-primary hover:underline">Older →</Link>}
          </nav>
        )}
      </Container>
    </AppShell>
  );
}
