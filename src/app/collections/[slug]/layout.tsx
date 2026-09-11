import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { canEdit, canViewCollection } from "@/lib/auth/access";
import { collectionCoverFor, getCollectionBySlug, type CollectionWithCounts } from "@/lib/collections/queries";
import { photoUrl } from "@/lib/photos/urls";
import { shareableCollectionUrl } from "@/lib/share/social";
import { TripTheme } from "@/themes/TripTheme";
import { Nav } from "@/components/layout/Nav";
import { CollectionHeader } from "@/components/collections/CollectionHeader";
import { TripTabs } from "@/components/trips/TripTabs";

export async function generateMetadata({ params }: LayoutProps<"/collections/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollectionBySlug(slug);
  if (!collection) return { title: "Collection" };
  const isPublic = collection.visibility === "PUBLIC";
  return {
    title: collection.title,
    robots: isPublic ? undefined : { index: false, follow: false },
    openGraph: isPublic ? await openGraphForCollection(collection, new URL(`/collections/${slug}`, env().APP_URL).toString()) : undefined,
  };
}

/** Open Graph tags so link previews show the title and cover; `imageToken` lets a LINK collection's cover load without a cookie. */
export async function openGraphForCollection(collection: CollectionWithCounts, pageUrl: string, imageToken?: string): Promise<Metadata["openGraph"]> {
  const cover = await collectionCoverFor(collection);
  const images = cover ? [{ url: new URL(`${photoUrl(cover, "medium")}${imageToken ? `&share=${encodeURIComponent(imageToken)}&kind=collection` : ""}`, env().APP_URL).toString() }] : [];
  return { type: "website", siteName: "Family Album", title: collection.title, description: collection.description ?? `${collection._count.items} photos`, url: pageUrl, images };
}

export default async function CollectionLayout({ params, children }: LayoutProps<"/collections/[slug]">) {
  const { slug } = await params;
  const [viewer, collection] = await Promise.all([getViewer(), getCollectionBySlug(slug)]);
  if (!collection) notFound();
  if (!canViewCollection(viewer, collection)) redirect(`/auth/signin?next=${encodeURIComponent(`/collections/${slug}`)}`);
  const editable = canEdit(viewer);
  const base = `/collections/${slug}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/map`, label: "Map" },
    ...(editable ? [{ href: `${base}/settings`, label: "Settings" }] : []),
  ];
  return (
    <TripTheme themeKey={collection.themeKey}>
      <Nav viewer={viewer} />
      <CollectionHeader collection={collection} shareUrl={shareableCollectionUrl(collection, env().APP_URL)} />
      <TripTabs tabs={tabs} />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">{children}</main>
    </TripTheme>
  );
}
