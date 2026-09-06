import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip, canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { TripTheme } from "@/themes/TripTheme";
import { Nav } from "@/components/layout/Nav";
import { TripHeader } from "@/components/trips/TripHeader";
import { TripTabs } from "@/components/trips/TripTabs";

export async function generateMetadata({ params }: LayoutProps<"/trips/[slug]">) {
  const { slug } = await params;
  const trip = await getTripBySlug(slug);
  return { title: trip?.title ?? "Trip", robots: trip?.visibility === "PUBLIC" ? undefined : { index: false, follow: false } };
}

export default async function TripLayout({ params, children }: LayoutProps<"/trips/[slug]">) {
  const { slug } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  if (!canViewTrip(viewer, trip)) redirect(`/auth/signin?next=${encodeURIComponent(`/trips/${slug}`)}`);
  const editable = canEditTrip(viewer);
  const base = `/trips/${slug}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/map`, label: "Map" },
    { href: `${base}/activities`, label: "Activities" },
    ...(editable ? [{ href: `${base}/import`, label: "Import tracks" }, { href: `${base}/settings`, label: "Settings" }] : []),
  ];

  return (
    <TripTheme themeKey={trip.themeKey}>
      <Nav viewer={viewer} />
      <TripHeader trip={trip} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
