import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "@/lib/env";
import { coverFor, type TripWithCounts } from "@/lib/trips/queries";
import { shareableTripUrl } from "@/lib/share/social";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { canEditContainer } from "@/lib/auth/ownership";
import { mlConfigured } from "@/lib/ml/client";
import { getTripBySlug } from "@/lib/trips/queries";
import { TripTheme } from "@/themes/TripTheme";
import { Nav } from "@/components/layout/Nav";
import { TripHeader } from "@/components/trips/TripHeader";
import { TripTabs } from "@/components/trips/TripTabs";
import { previewCard } from "@/lib/share/preview";
import { annotationGates } from "@/lib/annotation/eligibility";
import { describeTripWithAi, setTripDescription } from "./actions";

export async function generateMetadata({ params }: LayoutProps<"/trips/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const trip = await getTripBySlug(slug);
  if (!trip) return { title: "Trip" };
  const isPublic = trip.visibility === "PUBLIC";
  // Only public trips get a preview card: a private URL would leak the cover photo to link scrapers.
  const card = isPublic ? await tripCard(trip, new URL(`/trips/${slug}`, env().APP_URL).toString()) : null;
  return {
    title: trip.title,
    robots: isPublic ? undefined : { index: false, follow: false },
    openGraph: card?.openGraph,
    twitter: card?.twitter,
  };
}

/** The card a link to this trip carries: its title, its dates or description, and its cover photo. */
export async function tripCard(trip: TripWithCounts, pageUrl: string, shareToken?: string) {
  const cover = await coverFor(trip);
  const description = trip.description?.trim() || formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate));
  return previewCard({ title: trip.title, description, pageUrl, cover, appUrl: env().APP_URL, shareToken, shareKind: "trip" });
}


export default async function TripLayout({ params, children }: LayoutProps<"/trips/[slug]">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  if (!canViewTrip(viewer, trip)) redirect(`/auth/signin?next=${encodeURIComponent(`/trips/${slug}`)}`);
  // Importing tracks and changing a trip's settings shape the trip itself, so they belong to whoever made it.
  const owns = viewer.kind === "user" && canEditContainer(viewer.user, trip);
  const base = `/trips/${slug}`;
  // The days the trip was come first, because that is how a trip is remembered and it is what the trip now opens
  // on. The grid and the summary are kept but sit at the back, and the two that shape the trip itself last of all.
  const tabs = [
    { href: base, label: "Timeline", exact: true },
    { href: `${base}/map`, label: "Map" },
    { href: `${base}/activities`, label: "Activities" },
    // A member's own, and the family's shortlist: nothing for somebody holding a share link.
    ...(viewer.kind === "user" ? [{ href: `${base}/favorites`, label: "Favorites" }] : []),
    // What the album thinks looks alike is for the family, not for whoever holds a share link.
    ...(viewer.kind === "user" && mlConfigured() ? [{ href: `${base}/graph`, label: "Graph" }] : []),
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/overview`, label: "Overview" },
    ...(owns ? [{ href: `${base}/import`, label: "Import tracks" }, { href: `${base}/settings`, label: "Settings" }] : []),
  ];

  return (
    <TripTheme themeKey={trip.themeKey}>
      <Nav viewer={viewer} />
      <TripHeader
        trip={trip}
        shareUrl={shareableTripUrl(trip, env().APP_URL)}
        {...(owns ? { save: setTripDescription.bind(null, slug), ...((await annotationGates()).active ? { describe: describeTripWithAi.bind(null, slug) } : {}) } : {})}
      />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
