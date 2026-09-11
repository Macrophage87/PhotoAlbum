"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { generateToken } from "@/lib/auth/tokens";
import { uniqueSlug } from "@/lib/trips/slug";
import { fieldErrors } from "@/lib/trips/validation";
import { collectionInputFromForm } from "@/lib/collections/validation";
import type { TripFormState } from "@/app/trips/new/actions";

export type CollectionFormState = TripFormState;

async function loadEditableCollection(slug: string) {
  await requireUserOrThrow();
  const collection = await db.collection.findUnique({ where: { slug } });
  if (!collection) throw new Error("Collection not found");
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

export async function updateCollection(slug: string, _prev: CollectionFormState, fd: FormData): Promise<CollectionFormState> {
  const collection = await loadEditableCollection(slug);
  const parsed = collectionInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  await db.collection.update({ where: { id: collection.id }, data: { title: v.title, description: v.description, themeKey: v.themeKey } });
  revalidatePath(`/collections/${slug}`, "layout");
  revalidatePath("/");
  redirect(`/collections/${slug}/settings?saved=1`);
}

const visibilitySchema = z.enum(["PRIVATE", "LINK", "PUBLIC"]);

export async function setCollectionVisibility(slug: string, fd: FormData): Promise<void> {
  const collection = await loadEditableCollection(slug);
  const visibility = visibilitySchema.parse(fd.get("visibility"));
  const shareToken = visibility === "LINK" ? (collection.shareToken ?? generateToken()) : null;
  await db.collection.update({ where: { id: collection.id }, data: { visibility, shareToken } });
  await bumpItemVersions(collection.id);
  revalidatePath(`/collections/${slug}`, "layout");
  revalidatePath("/");
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

export async function deleteCollection(slug: string): Promise<void> {
  const collection = await loadEditableCollection(slug);
  await db.collection.delete({ where: { id: collection.id } });
  revalidatePath("/");
  redirect("/");
}

const ids = z.array(z.string().min(1)).min(1).max(500);

/** Add photos to a collection (existing members are skipped). Returns how many were added. */
export async function addToCollection(collectionId: string, photoIds: string[]): Promise<number> {
  const user = await requireUserOrThrow();
  const list = ids.parse(photoIds);
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
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
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
