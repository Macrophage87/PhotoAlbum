import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { shareableTripUrl } from "@/lib/share/social";
import { cookies } from "next/headers";
import { getSharedTrip } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { TripTheme } from "@/themes/TripTheme";
import { TripHeader } from "@/components/trips/TripHeader";
import { TripTabs } from "@/components/trips/TripTabs";
import { ShareCookie } from "./ShareCookie";
import { tripCard } from "@/app/trips/[slug]/layout";

export async function generateMetadata({ params }: LayoutProps<"/share/[token]">): Promise<Metadata> {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) return { title: "Shared trip", robots: { index: false, follow: false } };
  // The cover image URL carries the share token so link previews can fetch it without the cookie.
  const card = await tripCard(trip, new URL(`/share/${token}`, env().APP_URL).toString(), token);
  return { title: trip.title, robots: { index: false, follow: false }, openGraph: card.openGraph, twitter: card.twitter };
}


/** Read-only trip view for people holding the secret link. Sets a cookie so image requests are authorised. */
export default async function ShareLayout({ params, children }: LayoutProps<"/share/[token]">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const held = (await cookies()).get(`${SHARE_COOKIE_PREFIX}${shareKey("trip", trip.id)}`)?.value;
  const base = `/share/${token}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/map`, label: "Map" },
  ];
  // First visit: set the cookie before rendering anything that requests photos, then refresh.
  if (held !== token) {
    return (
      <TripTheme themeKey={trip.themeKey}>
        <ShareCookie kind="trip" id={trip.id} token={token} />
        <div className="min-h-[50vh] flex items-center justify-center text-muted">Opening shared trip…</div>
      </TripTheme>
    );
  }
  return (
    <TripTheme themeKey={trip.themeKey}>
      <div className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-12 flex items-center justify-between text-sm">
          <span className="font-display font-semibold">Family Album</span>
          <span className="text-muted">Shared with you</span>
        </div>
      </div>
      <TripHeader trip={trip} shareUrl={shareableTripUrl(trip, env().APP_URL)} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
