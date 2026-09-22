import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { canEditContainer } from "@/lib/auth/ownership";
import { mlConfigured } from "@/lib/ml/client";
import { canViewCollection } from "@/lib/auth/access";
import { collectionCoverFor, getCollectionBySlug, type CollectionWithCounts } from "@/lib/collections/queries";
import { shareableCollectionUrl } from "@/lib/share/social";
import { TripTheme } from "@/themes/TripTheme";
import { Nav } from "@/components/layout/Nav";
import { CollectionHeader } from "@/components/collections/CollectionHeader";
import { TripTabs } from "@/components/trips/TripTabs";
import { previewCard } from "@/lib/share/preview";
import { annotationGates } from "@/lib/annotation/eligibility";
import { describeCollectionWithAi, setCollectionDescription } from "@/app/collections/actions";

export async function generateMetadata({ params }: LayoutProps<"/collections/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollectionBySlug(slug);
  if (!collection) return { title: "Collection" };
  const isPublic = collection.visibility === "PUBLIC";
  const card = isPublic ? await collectionCard(collection, new URL(`/collections/${slug}`, env().APP_URL).toString()) : null;
  return {
    title: collection.title,
    robots: isPublic ? undefined : { index: false, follow: false },
    openGraph: card?.openGraph,
    twitter: card?.twitter,
  };
}

/** The card a link to this collection carries; `shareToken` lets a secret link's cover load without a cookie. */
export async function collectionCard(collection: CollectionWithCounts, pageUrl: string, shareToken?: string) {
  const cover = await collectionCoverFor(collection);
  const description = collection.description?.trim() || `${collection._count.items} photo${collection._count.items === 1 ? "" : "s"}`;
  return previewCard({ title: collection.title, description, pageUrl, cover, appUrl: env().APP_URL, shareToken, shareKind: "collection" });
}

export default async function CollectionLayout({ params, children }: LayoutProps<"/collections/[slug]">) {
  const { slug } = await params;
  const [viewer, collection] = await Promise.all([getViewer(), getCollectionBySlug(slug)]);
  if (!collection) notFound();
  if (!canViewCollection(viewer, collection)) redirect(`/auth/signin?next=${encodeURIComponent(`/collections/${slug}`)}`);
  // Settings shape the collection itself: whoever gathered it, and admins.
  const owns = viewer.kind === "user" && canEditContainer(viewer.user, collection);
  const base = `/collections/${slug}`;
  // As on a trip: the days first, the grid and the summary kept but at the back, and settings last.
  const tabs = [
    { href: base, label: "Timeline", exact: true },
    { href: `${base}/map`, label: "Map" },
    // A member's own, and the family's shortlist: nothing for somebody holding a share link.
    ...(viewer.kind === "user" ? [{ href: `${base}/favourites`, label: "Favourites" }] : []),
    // What the album thinks looks alike is for the family, not for whoever holds a share link.
    ...(viewer.kind === "user" && mlConfigured() ? [{ href: `${base}/graph`, label: "Graph" }] : []),
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/overview`, label: "Overview" },
    ...(owns ? [{ href: `${base}/settings`, label: "Settings" }] : []),
  ];
  return (
    <TripTheme themeKey={collection.themeKey}>
      <Nav viewer={viewer} />
      <CollectionHeader
        collection={collection}
        shareUrl={shareableCollectionUrl(collection, env().APP_URL)}
        {...(owns ? { save: setCollectionDescription.bind(null, slug), ...((await annotationGates()).active ? { describe: describeCollectionWithAi.bind(null, slug) } : {}) } : {})}
      />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
