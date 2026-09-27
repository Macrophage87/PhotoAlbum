"use client";

import { useEffect, useState, useTransition } from "react";
import { toggleFavourite } from "@/app/favorites/actions";
import type { FavouriteKind, FavouriteState } from "@/lib/favourites/queries";

const NOUN = { photo: "photo", trip: "trip", collection: "collection" } as const;

/** Told to every heart on the page, so the one on a grid tile follows a press of the one in the lightbox over it. */
const CHANGED = "favourite-changed";
type Changed = { kind: FavouriteKind; id: string; state: FavouriteState; from: symbol };

/**
 * The heart. Filled when this member has marked it, with the family's total beside it once anyone has — which is
 * also the order these things are listed in, so pressing it visibly moves something up the page.
 */
export function FavouriteButton({ kind, id, initial, dark = false, size = "md", withLabel = false }: { kind: FavouriteKind; id: string; initial: FavouriteState; dark?: boolean; size?: "sm" | "md"; /** Say "Favourite" beside the heart, where there is room: a bare ♡ is easy to miss on a big picture. */ withLabel?: boolean }) {
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const [self] = useState(() => Symbol("heart"));
  useEffect(() => {
    const heard = (e: Event) => {
      const d = (e as CustomEvent<Changed>).detail;
      if (d.from !== self && d.kind === kind && d.id === id) setState(d.state);
    };
    window.addEventListener(CHANGED, heard);
    return () => window.removeEventListener(CHANGED, heard);
  }, [kind, id, self]);
  const tell = (next: FavouriteState) => window.dispatchEvent(new CustomEvent<Changed>(CHANGED, { detail: { kind, id, state: next, from: self } }));
  const label = state.mine ? `Remove this ${NOUN[kind]} from your favorites` : `Make this one of your favorite ${NOUN[kind]}s`;
  const tone = dark ? "text-white/70 hover:text-white" : "text-muted hover:text-text";

  return (
    <button
      type="button"
      aria-pressed={state.mine}
      aria-label={label}
      title={state.count > 1 ? `${state.count} of us have this as a favorite` : label}
      disabled={pending}
      data-testid={`favorite-${kind}`}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${size === "sm" ? "text-xs" : "text-sm"} ${state.mine ? (dark ? "text-rose-400" : "text-rose-600") : tone} disabled:opacity-60`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !state.mine;
        // Answer the press at once and correct from the server, so a heart never feels like it is thinking.
        const guess = { mine: next, count: Math.max(0, state.count + (next ? 1 : -1)) };
        setState(guess);
        tell(guess);
        start(async () => {
          const settled = await toggleFavourite(kind, id, next);
          setState(settled);
          tell(settled);
        });
      }}
    >
      <span aria-hidden>{state.mine ? "♥" : "♡"}</span>
      {withLabel && <span>{state.mine ? "Favorite" : "Add to favorites"}</span>}
      {state.count > 0 && <span className={state.mine ? "" : tone}>{withLabel ? `· ${state.count}` : state.count}</span>}
    </button>
  );
}
