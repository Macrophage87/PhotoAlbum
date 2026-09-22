import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { FAVOURITES_LIMIT, favouritePhotos, photoFavourites, type FavouriteWho } from "@/lib/favourites/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";

/** `?who=family` asks for everybody's; anything else is this member's own. */
export function parseWho(value: string | string[] | undefined): FavouriteWho {
  return value === "family" ? "family" : "mine";
}

/**
 * The favourites of one place — the whole album, a trip, or a collection — for a signed-in member.
 *
 * Two lists behind one switch. Mine is what a favourites list is for: the ones I marked, newest first, so last
 * week's is at the top. Everyone's is the family's shortlist, most-loved first — what to put on the fridge, or
 * in the slideshow at the anniversary. Each tile keeps its heart, so a favourite can be let go of from here.
 */
export async function FavouritesView({ viewer, scope, who, base, where }: { viewer: Extract<Viewer, { kind: "user" }>; scope: { tripId?: string; collectionId?: string }; who: FavouriteWho; /** This page's own address, for the switch. */ base: string; /** "in this trip", "in this collection", or "" for the whole album — said in the empty message. */ where: string }) {
  const photos = await favouritePhotos(scope, who, viewer.user.id);
  const hearts = await photoFavourites(photos.map((p) => p.id), viewer);
  const tab = (value: FavouriteWho, label: string) => (
    <Link
      href={value === "mine" ? base : `${base}?who=family`}
      aria-current={who === value ? "page" : undefined}
      className={`px-3 py-1.5 rounded-theme text-sm ${who === value ? "bg-primary text-primary-fg" : "hover:bg-surface-alt"}`}
      data-testid={`favorites-${value}`}
    >
      {label}
    </Link>
  );
  const empty =
    who === "mine"
      ? `You have no favorites${where ? ` ${where}` : ""} yet. Press the ♡ on any photograph — in the grid, or when you are looking at it — and it will be here.`
      : `Nobody in the family has marked a favorite${where ? ` ${where}` : ""} yet.`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">Favorites</h2>
        <nav className="flex gap-1" aria-label="Whose favorites">
          {tab("mine", "Mine")}
          {tab("family", "Everyone's")}
        </nav>
      </div>
      {photos.length > 0 && (
        <p className="text-sm text-muted" data-testid="favorites-count">
          {photos.length === FAVOURITES_LIMIT ? `The first ${FAVOURITES_LIMIT}` : `${photos.length} photo${photos.length === 1 ? "" : "s"}`}
          {who === "mine" ? ", the most recently marked first." : ", the ones most of us marked first."}
        </p>
      )}
      <PhotoGrid photos={photos.map((p) => toGridPhoto(p, null, true, hearts.get(p.id)))} emptyMessage={empty} />
    </div>
  );
}
