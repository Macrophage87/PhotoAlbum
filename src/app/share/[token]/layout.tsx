import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSharedTrip } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { TripTheme } from "@/themes/TripTheme";
import { TripHeader } from "@/components/trips/TripHeader";
import { TripTabs } from "@/components/trips/TripTabs";
import { ShareCookie } from "./ShareCookie";

export async function generateMetadata({ params }: LayoutProps<"/share/[token]">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  return { title: trip?.title ?? "Shared trip", robots: { index: false, follow: false } };
}

/** Read-only trip view for people holding the secret link. Sets a cookie so image requests are authorised. */
export default async function ShareLayout({ params, children }: LayoutProps<"/share/[token]">) {
  const { token } = await params;
  const trip = await getSharedTrip(token);
  if (!trip) notFound();
  const held = (await cookies()).get(`${SHARE_COOKIE_PREFIX}${trip.id}`)?.value;
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
        <ShareCookie tripId={trip.id} token={token} />
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
      <TripHeader trip={trip} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
