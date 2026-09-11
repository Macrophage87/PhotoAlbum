import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canEdit, canViewCollection } from "@/lib/auth/access";
import { getCollectionBySlug } from "./queries";

/** Load a collection for a page under /collections/[slug] and enforce visibility (every page calls this itself). */
export async function loadViewableCollection(slug: string, nextPath = `/collections/${slug}`) {
  const [viewer, collection] = await Promise.all([getViewer(), getCollectionBySlug(slug)]);
  if (!collection) notFound();
  if (!canViewCollection(viewer, collection)) redirect(`/auth/signin?next=${encodeURIComponent(nextPath)}`);
  return { viewer, collection, editable: canEdit(viewer) };
}
