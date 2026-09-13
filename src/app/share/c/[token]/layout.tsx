import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { getSharedCollection } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { shareableCollectionUrl } from "@/lib/share/social";
import { TripTheme } from "@/themes/TripTheme";
import { CollectionHeader } from "@/components/collections/CollectionHeader";
import { TripTabs } from "@/components/trips/TripTabs";
import { ShareCookie } from "@/app/share/[token]/ShareCookie";
import { collectionCard } from "@/app/collections/[slug]/layout";

export async function generateMetadata({ params }: LayoutProps<"/share/c/[token]">): Promise<Metadata> {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) return { title: "Shared collection", robots: { index: false, follow: false } };
  // The cover image URL carries the share token so link previews can fetch it without the cookie.
  const card = await collectionCard(collection, new URL(`/share/c/${token}`, env().APP_URL).toString(), token);
  return { title: collection.title, robots: { index: false, follow: false }, openGraph: card.openGraph, twitter: card.twitter };
}

/** Read-only collection view for people holding the secret link. Sets a cookie so image requests are authorised. */
export default async function SharedCollectionLayout({ params, children }: LayoutProps<"/share/c/[token]">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  const held = (await cookies()).get(`${SHARE_COOKIE_PREFIX}${shareKey("collection", collection.id)}`)?.value;
  const base = `/share/c/${token}`;
  const tabs = [
    { href: base, label: "Photos", exact: true },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/map`, label: "Map" },
  ];
  if (held !== token) {
    return (
      <TripTheme themeKey={collection.themeKey}>
        <ShareCookie kind="collection" id={collection.id} token={token} />
        <div className="min-h-[50vh] flex items-center justify-center text-muted">Opening shared collection…</div>
      </TripTheme>
    );
  }
  return (
    <TripTheme themeKey={collection.themeKey}>
      <div className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-12 flex items-center justify-between text-sm">
          <span className="font-display font-semibold">Family Album</span>
          <span className="text-muted">Shared with you</span>
        </div>
      </div>
      <CollectionHeader collection={collection} shareUrl={shareableCollectionUrl(collection, env().APP_URL)} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
