"use server";

import { revalidatePath } from "next/cache";
import { candidatePhotoPage } from "@/lib/photos/page";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { GridPhoto } from "@/components/photos/PhotoGrid";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { levelOf } from "@/lib/visibility/exposure";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { generateToken } from "@/lib/auth/tokens";
import { uniqueSlug } from "@/lib/trips/slug";
import { fieldErrors } from "@/lib/trips/validation";
import { collectionInputFromForm } from "@/lib/collections/validation";
import { canEditContainer, editableMediaIds, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import type { TripFormState } from "@/app/trips/new/actions";

export type CollectionFormState = TripFormState;

/** The collection, where this member may change it: whoever gathered it, and admins. */
async function loadEditableCollection(slug: string) {
  const user = await requireUserOrThrow();
  const collection = await db.collection.findUnique({ where: { slug } });
  if (!collection) throw new Error("Collection not found");
  if (!canEditContainer(user, collection)) throw new Error(NOT_YOUR_CONTAINER);
  return collection;
}

/** Bump the versioned URLs of a collection's items so shared caches stop matching after a change in exposure. */
async function bumpItemVersions(collectionId: string) {
  await db.photo.updateMany({ where: { collections: { some: { collectionId } } }, data: { updatedAt: new Date() } });
}

export async function createCollection(_prev: CollectionFormState, fd: FormData): Promise<CollectionFormState> {
  const user = await requireUserOrThrow();
  const parsed = collectionInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const slug = await uniqueSlug(v.title, async (s) => Boolean(await db.collection.findUnique({ where: { slug: s }, select: { id: true } })));
  await db.collection.create({ data: { slug, title: v.title, description: v.description, themeKey: v.themeKey, createdById: user.id } });
  revalidatePath("/");
  redirect(`/collections/${slug}`);
}

const visibilitySchema = z.enum(["PRIVATE", "LINK", "PUBLIC"]);

/** Save the collection's details and, when the settings form sends one, its visibility, under a single button. */
export async function updateCollection(slug: string, _prev: CollectionFormState, fd: FormData): Promise<CollectionFormState> {
  const collection = await loadEditableCollection(slug);
  const parsed = collectionInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const chosen = fd.has("visibility") ? visibilitySchema.safeParse(fd.get("visibility")) : null;
  if (chosen && !chosen.success) return { status: "error", message: "Pick who can see this collection." };
  const visibility = chosen?.data;
  const changed = visibility !== undefined && visibility !== collection.visibility;
  await db.collection.update({
    where: { id: collection.id },
    data: {
      title: v.title,
      description: v.description,
      themeKey: v.themeKey,
      // A link is minted the first time this collection is shared that way, and dropped whenever it stops being.
      ...(changed ? { visibility, shareToken: visibility === "LINK" ? (collection.shareToken ?? generateToken()) : null } : {}),
    },
  });
  if (changed) await bumpItemVersions(collection.id);
  revalidatePath(`/collections/${slug}`, "layout");
  revalidatePath("/");
  redirect(`/collections/${slug}/settings?saved=1`);
}

export async function rotateCollectionShareToken(slug: string): Promise<void> {
  const collection = await loadEditableCollection(slug);
  if (collection.visibility !== "LINK") return;
  await db.collection.update({ where: { id: collection.id }, data: { shareToken: generateToken() } });
  await bumpItemVersions(collection.id);
  revalidatePath(`/collections/${slug}/settings`);
}

export async function setCollectionCover(slug: string, photoId: string | null): Promise<void> {
  const collection = await loadEditableCollection(slug);
  if (photoId) {
    const item = await db.collectionItem.findFirst({ where: { collectionId: collection.id, photoId }, select: { id: true } });
    if (!item) throw new Error("Photo is not in this collection");
  }
  await db.collection.update({ where: { id: collection.id }, data: { coverPhotoId: photoId } });
  revalidatePath(`/collections/${slug}`, "layout");
  revalidatePath("/");
}

/** Admins only. The collection and its membership rows go; the photos stay in the album and on their trips. */
export async function deleteCollection(slug: string): Promise<void> {
  const collection = await loadEditableCollection(slug);
  const me = await requireUserOrThrow();
  if (me.role !== "ADMIN") throw new Error("Only an admin can delete a collection");
  await db.collection.delete({ where: { id: collection.id } });
  revalidatePath("/", "layout");
  redirect("/");
}

const ids = z.array(z.string().min(1)).min(1).max(500);

/**
 * Add photos to a collection (existing members are skipped). Returns how many were added.
 *
 * What this asks of a member is rights over the photographs, not over the collection: filing your own pictures
 * under "Christmas mornings" is the ordinary use of a family collection, and putting somebody else's there —
 * which can widen who sees it — is not yours to do.
 */
export async function addToCollection(collectionId: string, photoIds: string[]): Promise<number> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return 0;
  const collection = await db.collection.findUnique({ where: { id: collectionId }, select: { id: true, slug: true } });
  if (!collection) throw new Error("Collection not found");
  const [existing, photos, last] = await Promise.all([
    db.collectionItem.findMany({ where: { collectionId, photoId: { in: list } }, select: { photoId: true } }),
    db.photo.findMany({ where: { id: { in: list } }, select: { id: true } }),
    db.collectionItem.findFirst({ where: { collectionId }, orderBy: { position: "desc" }, select: { position: true } }),
  ]);
  const held = new Set(existing.map((e) => e.photoId));
  const fresh = photos.map((p) => p.id).filter((id) => !held.has(id));
  let position = (last?.position ?? -1) + 1;
  if (fresh.length) {
    await db.collectionItem.createMany({ data: fresh.map((photoId) => ({ collectionId, photoId, addedById: user.id, position: position++ })) });
    await db.collection.update({ where: { id: collectionId }, data: { updatedAt: new Date() } });
    await bumpItemVersions(collectionId);
  }
  revalidatePath(`/collections/${collection.slug}`, "layout");
  revalidatePath("/", "layout");
  return fresh.length;
}

export async function removeFromCollection(collectionId: string, photoIds: string[]): Promise<void> {
  const user = await requireUserOrThrow();
  // Taking a photo out is the same decision as putting it in — unless the collection is yours, when tidying it is.
  const collectionOwner = await db.collection.findUnique({ where: { id: collectionId }, select: { createdById: true } });
  const list = collectionOwner && canEditContainer(user, collectionOwner) ? ids.parse(photoIds) : await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
  const collection = await db.collection.findUnique({ where: { id: collectionId }, select: { slug: true, coverPhotoId: true } });
  if (!collection) return;
  await db.collectionItem.deleteMany({ where: { collectionId, photoId: { in: list } } });
  if (collection.coverPhotoId && list.includes(collection.coverPhotoId)) await db.collection.update({ where: { id: collectionId }, data: { coverPhotoId: null } });
  await db.photo.updateMany({ where: { id: { in: list } }, data: { updatedAt: new Date() } });
  revalidatePath(`/collections/${collection.slug}`, "layout");
  revalidatePath("/", "layout");
}

/** Toggle a single photo's membership from the photo page. */
export async function togglePhotoInCollection(photoId: string, collectionId: string, member: boolean): Promise<void> {
  if (member) await addToCollection(collectionId, [photoId]);
  else await removeFromCollection(collectionId, [photoId]);
  revalidatePath(`/photos/${photoId}`);
}

const orderSchema = z.array(z.string().min(1)).max(5000);

/** Persist an explicit item order (the full list of item ids in the new order). */
export async function reorderCollection(slug: string, itemIds: string[]): Promise<void> {
  const collection = await loadEditableCollection(slug);
  const order = orderSchema.parse(itemIds);
  await db.$transaction(order.map((id, position) => db.collectionItem.updateMany({ where: { id, collectionId: collection.id }, data: { position } })));
  revalidatePath(`/collections/${slug}`, "layout");
}

/** Order the items by the date each photo was taken, undated last. */
export async function sortCollectionByDate(slug: string): Promise<void> {
  const collection = await loadEditableCollection(slug);
  const items = await db.collectionItem.findMany({ where: { collectionId: collection.id }, select: { id: true, photo: { select: { takenAt: true, createdAt: true } } } });
  items.sort((a, b) => (a.photo.takenAt?.getTime() ?? Infinity) - (b.photo.takenAt?.getTime() ?? Infinity) || a.photo.createdAt.getTime() - b.photo.createdAt.getTime());
  await db.$transaction(items.map((it, position) => db.collectionItem.update({ where: { id: it.id }, data: { position } })));
  revalidatePath(`/collections/${slug}`, "layout");
}

/**
 * After lowering a collection's visibility: remove its items from every other collection that is more visible than
 * this one now is. Trips cannot be changed from here; the settings page links to them.
 */
export async function detachExposedFromOtherCollections(slug: string): Promise<void> {
  const collection = await loadEditableCollection(slug);
  const level = levelOf(collection.visibility);
  const items = await db.collectionItem.findMany({ where: { collectionId: collection.id }, select: { photoId: true } });
  const others = await db.collectionItem.findMany({ where: { photoId: { in: items.map((i) => i.photoId) }, collectionId: { not: collection.id } }, select: { id: true, photoId: true, collection: { select: { id: true, visibility: true, coverPhotoId: true } } } });
  const doomed = others.filter((i) => levelOf(i.collection.visibility) > level);
  if (doomed.length) {
    await db.collectionItem.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    for (const c of doomed.filter((d) => d.collection.coverPhotoId === d.photoId)) await db.collection.update({ where: { id: c.collection.id }, data: { coverPhotoId: null } });
    await db.photo.updateMany({ where: { id: { in: doomed.map((d) => d.photoId) } }, data: { updatedAt: new Date() } });
  }
  revalidatePath(`/collections/${slug}`, "layout");
  revalidatePath("/", "layout");
  redirect(`/collections/${slug}/settings?saved=1`);
}

/** The next page of the "add existing photos" picker, as grid items. */
export async function moreCandidates(slug: string, filter: { trip?: string | null; q?: string | null; from?: string | null; to?: string | null }, cursor: string): Promise<{ photos: GridPhoto[]; nextCursor: string | null }> {
  await requireUserOrThrow();
  const collection = await db.collection.findUnique({ where: { slug }, select: { id: true } });
  if (!collection) throw new Error("Collection not found");
  const page = await candidatePhotoPage({ excludeCollectionId: collection.id, trip: filter.trip, q: filter.q, from: filter.from, to: filter.to }, { cursor });
  return { photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor };
}
