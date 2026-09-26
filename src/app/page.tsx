import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { ContainerSearch } from "@/components/containers/ContainerSearch";
import { favouritesFor } from "@/lib/favourites/queries";
import { countVisibleTrips, coverFor, listVisibleTrips } from "@/lib/trips/queries";
import { SORT_COOKIES, TRIP_SORTS, sortChoice } from "@/lib/sort-choice";
import { SortToggle } from "@/components/ui/SortToggle";
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
  // Favourites first unless this person has asked for the trips by date, either way round.
  const sort = await sortChoice(sp, SORT_COOKIES.trips, TRIP_SORTS, "favorites");
  const [trips, collections, tripCount, collectionCount] = await Promise.all([
    listVisibleTrips(viewer, { q, take: PAGE, skip, order: sort }),
    listVisibleCollections(viewer, { q, take: PAGE, skip }),
    countVisibleTrips(viewer, q),
    countVisibleCollections(viewer, q),
  ]);
  const [covers, collectionCovers, tripFavourites, collectionFavourites] = await Promise.all([
    Promise.all(trips.map((t) => coverFor(t))),
    Promise.all(collections.map((c) => collectionCoverFor(c))),
    favouritesFor("trip", trips.map((t) => t.id), viewer),
    favouritesFor("collection", collections.map((c) => c.id), viewer),
  ]);
  const member = viewer.kind === "user";
  const pages = Math.max(Math.ceil(tripCount / PAGE), Math.ceil(collectionCount / PAGE));
  const href = (n: number) => `/?${new URLSearchParams({ ...(q ? { q } : {}), ...(sp.order ? { order: sort } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`;

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
        <div className="mb-6 space-y-3">
          <ContainerSearch initial={q ?? ""} />
          {tripCount > 1 && (
            <SortToggle
              value={sort}
              options={[{ value: "favorites", label: "Favorites first" }, { value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]}
              cookie={SORT_COOKIES.trips}
              label="How the trips are ordered"
              testId="trips-order"
            />
          )}
        </div>
        {trips.length === 0 ? (
          <p className="text-muted">{member ? "No trips yet. Create the first one." : "Nothing public yet. Family members can sign in to see everything."}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {trips.map((t, i) => (
              <TripCard key={t.id} trip={t} cover={covers[i]} showVisibility={member} favourite={member ? tripFavourites.get(t.id) : null} />
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
                  <CollectionCard key={c.id} collection={c} cover={collectionCovers[i]} showVisibility={member} favourite={member ? collectionFavourites.get(c.id) : null} />
                ))}
              </div>
            )}
          </section>
        )}
        {pages > 1 && (
          <nav className="mt-10 flex flex-wrap items-center gap-2 text-sm" aria-label="More pages">
            {page > 1 && <Link href={href(page - 1)} className="text-primary hover:underline">← {sort === "oldest" ? "Earlier" : "Newer"}</Link>}
            <span className="text-muted">Page {page} of {pages}</span>
            {page < pages && <Link href={href(page + 1)} className="text-primary hover:underline">{sort === "oldest" ? "Later" : "Older"} →</Link>}
          </nav>
        )}
      </Container>
    </AppShell>
  );
}
