import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "@/lib/env";
import { coverFor, type TripWithCounts } from "@/lib/trips/queries";
import { photoUrl } from "@/lib/photos/urls";
import { shareableTripUrl } from "@/lib/share/social";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { canEditContainer } from "@/lib/auth/ownership";
import { getTripBySlug } from "@/lib/trips/queries";
import { TripTheme } from "@/themes/TripTheme";
import { Nav } from "@/components/layout/Nav";
import { TripHeader } from "@/components/trips/TripHeader";
import { TripTabs } from "@/components/trips/TripTabs";

export async function generateMetadata({ params }: LayoutProps<"/trips/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const trip = await getTripBySlug(slug);
  if (!trip) return { title: "Trip" };
  const isPublic = trip.visibility === "PUBLIC";
  return {
    title: trip.title,
    robots: isPublic ? undefined : { index: false, follow: false },
    // Only public trips get a preview card: a private URL would leak the cover photo to link scrapers.
    openGraph: isPublic ? await openGraphFor(trip, new URL(`/trips/${slug}`, env().APP_URL).toString()) : undefined,
  };
}

/** Open Graph tags so Facebook and chat apps show the title, dates and cover photo. */
async function openGraphFor(trip: TripWithCounts, pageUrl: string, imageToken?: string): Promise<Metadata["openGraph"]> {
  const cover = await coverFor(trip);
  const description = trip.description?.trim() || formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate));
  const images = cover
    ? [{ url: new URL(`${photoUrl(cover, "medium")}${imageToken ? `&share=${encodeURIComponent(imageToken)}&kind=trip` : ""}`, env().APP_URL).toString() }]
    : [];
  return { type: "website", siteName: "Family Album", title: trip.title, description, url: pageUrl, images };
}


export default async function TripLayout({ params, children }: LayoutProps<"/trips/[slug]">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  if (!canViewTrip(viewer, trip)) redirect(`/auth/signin?next=${encodeURIComponent(`/trips/${slug}`)}`);
  // Importing tracks and changing a trip's settings shape the trip itself, so they belong to whoever made it.
  const owns = viewer.kind === "user" && canEditContainer(viewer.user, trip);
  const base = `/trips/${slug}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/map`, label: "Map" },
    { href: `${base}/activities`, label: "Activities" },
    ...(owns ? [{ href: `${base}/import`, label: "Import tracks" }, { href: `${base}/settings`, label: "Settings" }] : []),
  ];

  return (
    <TripTheme themeKey={trip.themeKey}>
      <Nav viewer={viewer} />
      <TripHeader trip={trip} shareUrl={shareableTripUrl(trip, env().APP_URL)} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
