"use server";

import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { describeWidening } from "@/lib/visibility/exposure";
import { containerRef, itemsById, previewChange } from "@/lib/visibility/preview";

const ids = z.array(z.string().min(1)).min(1).max(500);

/** Sentences to confirm before adding photos to a collection; empty when nothing becomes more visible. */
export async function previewAddToCollection(photoIds: string[], collectionId: string): Promise<string[]> {
  await requireUserOrThrow();
  const collection = await containerRef("collection", collectionId);
  if (!collection) return [];
  const summary = await previewChange(await itemsById(ids.parse(photoIds)), { kind: "addToCollection", collection });
  return describeWidening(summary, `through the collection ${collection.title}`);
}

/** Sentences to confirm before moving photos to a trip; empty when nothing becomes more visible. */
export async function previewMoveToTrip(photoIds: string[], tripId: string | null): Promise<string[]> {
  await requireUserOrThrow();
  const trip = tripId ? await containerRef("trip", tripId) : null;
  if (tripId && !trip) return [];
  const summary = await previewChange(await itemsById(ids.parse(photoIds)), { kind: "moveToTrip", trip });
  return describeWidening(summary, trip ? `through the trip ${trip.title}` : "");
}
