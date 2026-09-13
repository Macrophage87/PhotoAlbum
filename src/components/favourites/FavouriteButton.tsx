"use client";

import { useState, useTransition } from "react";
import { toggleFavourite } from "@/app/favourites/actions";
import type { FavouriteKind, FavouriteState } from "@/lib/favourites/queries";

const NOUN = { photo: "photo", trip: "trip", collection: "collection" } as const;

/**
 * The heart. Filled when this member has marked it, with the family's total beside it once anyone has — which is
 * also the order these things are listed in, so pressing it visibly moves something up the page.
 */
export function FavouriteButton({ kind, id, initial, dark = false, size = "md" }: { kind: FavouriteKind; id: string; initial: FavouriteState; dark?: boolean; size?: "sm" | "md" }) {
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const label = state.mine ? `Remove this ${NOUN[kind]} from your favourites` : `Make this one of your favourite ${NOUN[kind]}s`;
  const tone = dark ? "text-white/70 hover:text-white" : "text-muted hover:text-foreground";

  return (
    <button
      type="button"
      aria-pressed={state.mine}
      aria-label={label}
      title={state.count > 1 ? `${state.count} of us have this as a favourite` : label}
      disabled={pending}
      data-testid={`favourite-${kind}`}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${size === "sm" ? "text-xs" : "text-sm"} ${state.mine ? "text-rose-600" : tone} disabled:opacity-60`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !state.mine;
        // Answer the press at once and correct from the server, so a heart never feels like it is thinking.
        setState((s) => ({ mine: next, count: Math.max(0, s.count + (next ? 1 : -1)) }));
        start(async () => setState(await toggleFavourite(kind, id, next)));
      }}
    >
      <span aria-hidden>{state.mine ? "♥" : "♡"}</span>
      {state.count > 0 && <span className={state.mine ? "" : tone}>{state.count}</span>}
    </button>
  );
}
