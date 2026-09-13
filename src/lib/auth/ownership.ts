import { db } from "@/lib/db";
import { requireUserOrThrow, type ViewerUser } from "./viewer";

/**
 * Who may change a thing.
 *
 * The album is read by the whole family and written by whoever brought each piece of it: the person who uploaded a
 * photo can caption it, date it, place it, crop it and file it, and so can an admin. Nobody else can — not because
 * anyone is untrusted, but because someone else's photograph carries their account of it, and quietly rewriting
 * that is not a thing a shared album should let one relative do to another. The same rule runs down the containers:
 * a trip, a collection or an activity is edited by whoever made it, and by admins.
 *
 * Two deliberate exceptions, both older decisions and both kept:
 *  - Anyone in the family can move an item to the trash, with a reason. That is a safety valve — "someone in it
 *    asked", "this should not be up" — it destroys nothing, and an admin restores or deletes from the Admin page.
 *  - Anyone can upload, and an upload lands on whatever trip, activity or collection the uploader chose. Adding
 *    your own photograph to the family's trip is not editing that trip.
 */

export type Owned = { uploaderId: string };
export type Made = { createdById: string | null };

export function isAdmin(user: Pick<ViewerUser, "role">): boolean {
  return user.role === "ADMIN";
}

/** The person who uploaded an item, and admins. */
export function canEditMedia(user: Pick<ViewerUser, "id" | "role"> | null, media: Owned): boolean {
  return Boolean(user) && (isAdmin(user!) || media.uploaderId === user!.id);
}

/** The person who made a trip, a collection or an activity's trip, and admins. */
export function canEditContainer(user: Pick<ViewerUser, "id" | "role"> | null, container: Made): boolean {
  return Boolean(user) && (isAdmin(user!) || (container.createdById !== null && container.createdById === user!.id));
}

/** What to say when someone is turned away, in the words of the rule rather than of the code. */
export const NOT_YOURS = "Only the family member who uploaded this, or an admin, can change it.";
export const NOT_YOUR_CONTAINER = "Only the family member who made this, or an admin, can change it.";

/** Load an item for editing, or throw. Returns the member making the change alongside it. */
export async function requireMediaEditor<T extends Owned>(id: string, select?: unknown): Promise<{ user: ViewerUser; media: T }> {
  const user = await requireUserOrThrow();
  const media = (await db.photo.findUnique({ where: { id }, ...(select ? { select: select as object } : {}) })) as (T & Owned) | null;
  if (!media) throw new Error("Photo not found");
  if (!canEditMedia(user, media)) throw new Error(NOT_YOURS);
  return { user, media: media as T };
}

/** The ids among these that this member may change — for the bulk actions, which act on a selection. */
export async function editableMediaIds(user: Pick<ViewerUser, "id" | "role">, ids: string[]): Promise<string[]> {
  if (isAdmin(user)) return ids;
  const mine = await db.photo.findMany({ where: { id: { in: ids }, uploaderId: user.id }, select: { id: true } });
  return mine.map((p) => p.id);
}

/** Load a trip for editing by slug, or throw. */
export async function requireTripEditor(slug: string): Promise<{ user: ViewerUser; trip: { id: string; slug: string; timezone: string; createdById: string | null } }> {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, slug: true, timezone: true, createdById: true } });
  if (!trip) throw new Error("Trip not found");
  if (!canEditContainer(user, trip)) throw new Error(NOT_YOUR_CONTAINER);
  return { user, trip };
}

/** Load a collection for editing by slug, or throw. */
export async function requireCollectionEditor(slug: string): Promise<{ user: ViewerUser; collection: { id: string; slug: string; createdById: string | null } }> {
  const user = await requireUserOrThrow();
  const collection = await db.collection.findUnique({ where: { slug }, select: { id: true, slug: true, createdById: true } });
  if (!collection) throw new Error("Collection not found");
  if (!canEditContainer(user, collection)) throw new Error(NOT_YOUR_CONTAINER);
  return { user, collection };
}
