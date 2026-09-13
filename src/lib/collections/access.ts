import { notFound, redirect } from "next/navigation";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { canEditContainer } from "@/lib/auth/ownership";
import { canContribute, canViewCollection } from "@/lib/auth/access";
import { getCollectionBySlug } from "./queries";

/** Load a collection for a page under /collections/[slug] and enforce visibility (every page calls this itself). */
export async function loadViewableCollection(slug: string, nextPath = `/collections/${slug}`) {
  const [viewer, collection] = await Promise.all([getViewer(), getCollectionBySlug(slug)]);
  if (!collection) notFound();
  if (!canViewCollection(viewer, collection)) redirect(`/auth/signin?next=${encodeURIComponent(nextPath)}`);
  // `editable`: a member, who may put their own things in. `owns`: whoever gathered it, and so arranges it.
  return { viewer, collection, editable: canContribute(viewer), owns: viewer.kind === "user" && canEditContainer(viewer.user, collection) };
}

/** Load a collection for a page that arranges it — its settings. Anyone else is sent back to the collection. */
export async function requireCollectionOwnerPage(slug: string, nextPath = `/collections/${slug}`) {
  const user = await requireUser(nextPath);
  const collection = await getCollectionBySlug(slug);
  if (!collection) notFound();
  if (!canEditContainer(user, collection)) redirect(`/collections/${slug}`);
  return { user, collection };
}
