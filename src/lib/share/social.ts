/**
 * Helpers for sharing a trip or collection on the open web. Only containers that anonymous visitors
 * can open are shareable: PUBLIC ones at their normal URL, LINK ones via the secret link.
 */
export type ShareableContainer = { slug: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null };

/** Absolute URL an outsider can open for this trip, or null for private trips. */
export function shareableTripUrl(trip: ShareableContainer, appUrl: string): string | null {
  if (trip.visibility === "PUBLIC") return new URL(`/trips/${trip.slug}`, appUrl).toString();
  if (trip.visibility === "LINK" && trip.shareToken) return new URL(`/share/${trip.shareToken}`, appUrl).toString();
  return null;
}

/** Absolute URL an outsider can open for this collection, or null for private ones. */
export function shareableCollectionUrl(collection: ShareableContainer, appUrl: string): string | null {
  if (collection.visibility === "PUBLIC") return new URL(`/collections/${collection.slug}`, appUrl).toString();
  if (collection.visibility === "LINK" && collection.shareToken) return new URL(`/share/c/${collection.shareToken}`, appUrl).toString();
  return null;
}

/** Facebook's share dialog. Needs no app id or SDK; the preview comes from the page's Open Graph tags. */
export function facebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}
