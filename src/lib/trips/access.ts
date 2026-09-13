import { notFound, redirect } from "next/navigation";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { canContribute, canViewTrip } from "@/lib/auth/access";
import { canEditContainer } from "@/lib/auth/ownership";
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
  // `editable`: a member, who may add their own things here. `owns`: whose trip this is, and so who arranges it.
  return { viewer, trip, editable: canContribute(viewer), owns: viewer.kind === "user" && canEditContainer(viewer.user, trip) };
}

/**
 * Load a trip for a page that arranges it — settings, track import, adding activities. Those shape the trip itself,
 * so they belong to whoever made it and to admins; anyone else is sent back to the trip they came from.
 */
export async function requireTripOwnerPage(slug: string, nextPath = `/trips/${slug}`) {
  const user = await requireUser(nextPath);
  const trip = await getTripBySlug(slug);
  if (!trip) notFound();
  if (!canEditContainer(user, trip)) redirect(`/trips/${slug}`);
  return { user, trip };
}
