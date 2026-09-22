"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { setFavourite, type FavouriteKind, type FavouriteState } from "@/lib/favourites/queries";

const args = z.object({ kind: z.enum(["photo", "trip", "collection"]), id: z.string().min(1), on: z.boolean() });

/** Mark or unmark something as one of this member's favourites. Everyone may mark anything they can see. */
export async function toggleFavourite(kind: FavouriteKind, id: string, on: boolean): Promise<FavouriteState> {
  const user = await requireUserOrThrow();
  const v = args.parse({ kind, id, on });
  const state = await setFavourite(v.kind, v.id, user.id, v.on);
  // Lists order by favourites, so the pages that show them have to be built again.
  revalidatePath("/", "layout");
  return state;
}
