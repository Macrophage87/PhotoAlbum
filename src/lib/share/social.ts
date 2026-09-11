/**
 * Helpers for sharing a trip on the open web. Only trips that anonymous visitors
 * can open are shareable: PUBLIC trips at their normal URL, LINK trips via the secret link.
 */
export type ShareableTrip = { slug: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; shareToken: string | null };

/** Absolute URL an outsider can open for this trip, or null for private trips. */
export function shareableTripUrl(trip: ShareableTrip, appUrl: string): string | null {
  if (trip.visibility === "PUBLIC") return new URL(`/trips/${trip.slug}`, appUrl).toString();
  if (trip.visibility === "LINK" && trip.shareToken) return new URL(`/share/${trip.shareToken}`, appUrl).toString();
  return null;
}

/** Facebook's share dialog. Needs no app id or SDK; the preview comes from the page's Open Graph tags. */
export function facebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}
