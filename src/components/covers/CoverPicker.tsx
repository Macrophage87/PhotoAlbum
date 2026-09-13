import Link from "next/link";
import { photoUrl } from "@/lib/photos/urls";
import { Button, Card } from "@/components/ui";
import type { CoverCandidate } from "@/lib/covers/candidates";

/**
 * Choosing the picture a trip or a collection is known by.
 *
 * Until now a cover could only be set from one photograph's own page, which means knowing in advance which one you
 * want and finding it. This is the other way round: here are the photographs, pick one. The one in use is marked,
 * and where none has been chosen the page says which the album picked by itself, so "the wrong photo is on the
 * front page" has an obvious thing to do about it.
 *
 * Every tile is a form button, so the page works before any JavaScript has loaded and from the keyboard.
 */
export function CoverPicker({ title, backHref, current, automatic, photos, nextCursor, total, pageHref, choose, clear }: {
  /** What is being fronted, in words: "Acadia, Maine" or "Every lighthouse". */
  title: string;
  backHref: string;
  /** The photograph chosen by hand, where one has been. */
  current: { id: string; updatedAt: Date } | null;
  /** What the album would lead with on its own, named for the reader. */
  automatic: { id: string; updatedAt: Date } | null;
  photos: CoverCandidate[];
  nextCursor: string | null;
  total: number;
  /** This page's own path, for the "more" link to hang a cursor off. */
  pageHref: string;
  choose: (photoId: string) => Promise<void>;
  clear: () => Promise<void>;
}) {
  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">Cover photo</h2>
          <p className="text-muted text-sm mt-1">
            The picture {title} is known by: on the front page, on its own header, and wherever it is shared.
          </p>
        </div>
        <Link href={backHref} className="text-sm text-primary underline-offset-2 hover:underline">Back</Link>
      </div>

      <Card className="p-4 flex flex-wrap items-center gap-4">
        <div className="w-28 h-28 rounded-theme overflow-hidden bg-surface-alt border border-border shrink-0">
          {(current ?? automatic) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl((current ?? automatic)!, "thumb")} alt="" className="w-full h-full object-cover" />
          )}
        </div>
        <div className="text-sm space-y-2">
          {current ? (
            <>
              <p>This one was chosen by hand.</p>
              <form action={clear}>
                <Button type="submit" size="sm" variant="secondary">Let the album choose</Button>
              </form>
            </>
          ) : (
            <p className="text-muted">
              {automatic ? "Nobody has chosen one, so the album leads with the earliest photograph here." : "Nothing to lead with yet."}
            </p>
          )}
        </div>
      </Card>

      {photos.length === 0 ? (
        <p className="text-muted text-sm">No finished photographs here yet.</p>
      ) : (
        <>
          <p className="text-sm text-muted">{total} to choose from.</p>
          <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2" data-testid="cover-picker">
            {photos.map((p) => {
              const chosen = (current ?? automatic)?.id === p.id;
              return (
                <li key={p.id}>
                  <form action={choose.bind(null, p.id)}>
                    <button
                      type="submit"
                      aria-label={`Use “${p.caption ?? p.title ?? p.originalName}” as the cover`}
                      aria-pressed={chosen}
                      className={`relative block w-full aspect-square rounded-theme overflow-hidden border bg-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${chosen ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(p, "thumb")} alt="" loading="lazy" className="w-full h-full object-cover" />
                      {chosen && <span className="absolute bottom-1 left-1 right-1 text-[10px] bg-black/65 text-white rounded px-1 py-0.5 text-center">{current ? "in use" : "chosen by the album"}</span>}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
          {nextCursor && (
            <p className="text-sm">
              <Link href={`${pageHref}?after=${encodeURIComponent(nextCursor)}`} className="text-primary hover:underline">More photographs →</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
