"use server";

import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { candidatePhotoPage } from "@/lib/photos/page";
import { parsePickerFilter } from "@/lib/photos/picker-filter";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { GridPhoto } from "@/components/photos/PhotoGrid";

/**
 * The next page of the picker for putting existing photographs on a trip. The filter arrives as the query string
 * the page is showing, so it is read back exactly the way the page read it.
 */
export async function moreTripCandidates(slug: string, query: string, cursor: string): Promise<{ photos: GridPhoto[]; nextCursor: string | null }> {
  await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true } });
  if (!trip) throw new Error("Trip not found");
  const filter = parsePickerFilter(Object.fromEntries(new URLSearchParams(query).entries()));
  const page = await candidatePhotoPage({ kind: "trip", id: trip.id }, filter, { cursor });
  return { photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor };
}
