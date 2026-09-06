import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip, canViewTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";

/**
 * Load a trip for a page under /trips/[slug] and enforce visibility.
 * Every page calls this itself: Next.js does not re-run the parent layout on client
 * navigation, so a check that lives only in the layout does not protect the page segments.
 */
export async function loadViewableTrip(slug: string, nextPath = `/trips/${slug}`) {
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  if (!canViewTrip(viewer, trip)) redirect(`/auth/signin?next=${encodeURIComponent(nextPath)}`);
  return { viewer, trip, editable: canEditTrip(viewer) };
}
