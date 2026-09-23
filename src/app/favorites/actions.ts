"use server";

import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { setFavourite, type FavouriteKind, type FavouriteState } from "@/lib/favourites/queries";

const args = z.object({ kind: z.enum(["photo", "trip", "collection"]), id: z.string().min(1), on: z.boolean() });

/** Mark or unmark something as one of this member's favourites. Everyone may mark anything they can see. */
export async function toggleFavourite(kind: FavouriteKind, id: string, on: boolean): Promise<FavouriteState> {
  const user = await requireUserOrThrow();
  const v = args.parse({ kind, id, on });
  const state = await setFavourite(v.kind, v.id, user.id, v.on);
  // Nothing is revalidated. The heart keeps its own state, and every page that lists favourites is built afresh for
  // each visit. Rebuilding the page underneath would remount the grid behind an open photograph and close it, and
  // makes the browser fetch every link on the page again, for one press of a heart.
  return state;
}
