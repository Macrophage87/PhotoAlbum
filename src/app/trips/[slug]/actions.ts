"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { fieldErrors, participantsFromForm, tripInputFromForm } from "@/lib/trips/validation";
import { dayToDateColumn } from "@/lib/time/local-day";
import { generateToken } from "@/lib/auth/tokens";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { TripFormState } from "@/app/trips/new/actions";
import { levelOf } from "@/lib/visibility/exposure";
import { canEditContainer, editableMediaIds, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { writeContainerDescription } from "@/lib/annotation/container";
import { handWrittenDescription } from "@/lib/annotation/members-only";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";
import { descriptionStaysHelpers } from "@/lib/annotation/helper-text";
import { deleteTripById } from "@/lib/trips/delete";
import { uniqueSlug } from "@/lib/trips/slug";
import { NAME_NOT_TO_BE_SHOWN, namesSomebodyRestricted } from "@/lib/people/forget";
import { isCoverable } from "@/lib/photos/cover";

/** The trip, where this member may change it: whoever made it, and admins. One being deleted is gone already. */
async function loadEditableTrip(slug: string) {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug, deletingAt: null } });
  if (!trip) throw new Error("Trip not found");
  if (!canEditContainer(user, trip)) throw new Error(NOT_YOUR_CONTAINER);
  return trip;
}

/** A write that found no live trip: it was deleted, or marked for deletion, since it was read. */
function tripGone(err: unknown): never {
  if ((err as { code?: string }).code === "P2025") throw new Error("Trip not found");
  throw err;
}

/** A description saved by hand, as stored; see `handWrittenDescription`. */
async function handWrittenStored(before: Parameters<typeof handWrittenDescription>[0], text: string | null | undefined) {
  const { descriptionMembersOnly, descriptionSharedAt } = await handWrittenDescription(before, text);
  return { descriptionMembersOnly, descriptionSharedAt };
}

const visibilitySchema = z.enum(["PRIVATE", "LINK", "PUBLIC"]);

/** Save the trip's details and, when the settings form sends one, its visibility, under a single button. */
export async function updateTrip(slug: string, _prev: TripFormState, fd: FormData): Promise<TripFormState> {
  const trip = await loadEditableTrip(slug);
  const parsed = tripInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const chosen = fd.has("visibility") ? visibilitySchema.safeParse(fd.get("visibility")) : null;
  if (chosen && !chosen.success) return { status: "error", message: "Pick who can see this trip." };
  const visibility = chosen?.data;
  const changed = visibility !== undefined && visibility !== trip.visibility;
  const there = participantsFromForm(fd);
  // Written only while it is not being deleted: a save that read the trip just before the mark must not share it again.
  await db.trip.update({
    where: { id: trip.id, deletingAt: null },
    data: {
      title: v.title,
      description: v.description,
      ...(await handWrittenStored(trip, v.description)),
      descriptionByHelper: descriptionStaysHelpers(trip, v.description),
      startDate: dayToDateColumn(v.startDate),
      endDate: dayToDateColumn(v.endDate),
      timezone: v.timezone,
      themeKey: v.themeKey,
      // A link is minted the first time this trip is shared that way, and dropped whenever it stops being.
      ...(changed ? { visibility, shareToken: visibility === "LINK" ? (trip.shareToken ?? generateToken()) : null } : {}),
      // `set` reconciles to exactly what was ticked; a form that never carried the control leaves the list alone.
      ...(there ? { participants: { set: there.map((id) => ({ id })) } } : {}),
    },
  }).catch(tripGone);
  // Whether a word of its title gives anything away depends on who may open it: judged again in the background.
  if (changed || v.title !== trip.title) await rejudgeFromAction({ tripId: trip.id });
  if (changed) {
    // Bump photo versions so public caches stop matching after a change in exposure.
    await db.photo.updateMany({ where: { tripId: trip.id }, data: { updatedAt: new Date(), imageVersion: { increment: 1 } } });
    revalidatePath("/");
  }
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/settings?saved=1`);
}

export async function rotateShareToken(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  if (trip.visibility !== "LINK") return;
  // Not a trip marked for deletion since it was read: its link was withdrawn with the mark.
  await db.trip.update({ where: { id: trip.id, deletingAt: null }, data: { shareToken: generateToken() } }).catch(tripGone);
  // New token, new rendition URLs: private caches keyed on the old ?v= stop matching.
  await db.photo.updateMany({ where: { tripId: trip.id }, data: { updatedAt: new Date(), imageVersion: { increment: 1 } } });
  revalidatePath(`/trips/${slug}/settings`);
}

/**
 * A new web address for the trip. It is made from the first title and never follows a rename, so it can still say
 * what the title no longer does — a forgotten person's name, say. Links to the old address stop working; there is
 * no redirect, since keeping the old address anywhere would keep what it said.
 */
export async function changeTripSlug(slug: string, fd: FormData): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const wanted = z.string().trim().min(1).max(80).parse(fd.get("slug"));
  const next = await uniqueSlug(wanted, async (s) => Boolean(await db.trip.findFirst({ where: { slug: s, id: { not: trip.id } }, select: { id: true } })));
  if (next !== trip.slug) await db.trip.update({ where: { id: trip.id }, data: { slug: next } });
  revalidatePath("/", "layout");
  redirect(`/trips/${next}/settings?saved=1`);
}

/** Choose (or forget) the picture the trip is known by. The cover belongs to the trip, so it is the trip's to set. */
export async function setCoverPhoto(slug: string, photoId: string | null): Promise<void> {
  const trip = await loadEditableTrip(slug);
  if (photoId) {
    const photo = await db.photo.findFirst({ where: { id: photoId, tripId: trip.id }, select: { status: true, trashedAt: true, width: true } });
    if (!photo) throw new Error("Photo is not on this trip");
    // Still processing, failed, or in the trash: there is no picture to lead with.
    if (!isCoverable(photo)) throw new Error("Only a finished photo can be the cover");
  }
  await db.trip.update({ where: { id: trip.id }, data: { coverPhotoId: photoId } });
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/");
}

/**
 * Admins only. The trip, its activities and tracks go; every photo stays in the album and becomes a photo without a
 * trip, so nothing anyone uploaded is ever lost by deleting a container. A big trip lets go of its photographs a
 * batch at a time; see lib/trips/delete for the steps, and for how a deletion interrupted half-way is finished.
 */
export async function deleteTrip(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const me = await requireUserOrThrow();
  if (me.role !== "ADMIN") throw new Error("Only an admin can delete a trip");
  const done = await deleteTripById(trip.id);
  revalidatePath("/", "layout");
  // A big one is finished by the worker; the Admin page says it is being deleted until then.
  redirect(done === "done" ? "/photos" : "/admin#being-deleted");
}

/** Clear track-derived positions and recompute them from the trip's current tracks. */
export async function regeotagPhotos(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  await db.photo.updateMany({ where: { tripId: trip.id, gpsSource: "TRACK" }, data: { lat: null, lng: null, altitude: null, gpsSource: null } });
  await enqueue(QUEUES.geotagPhotos, { tripId: trip.id });
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/settings?regeotag=1`);
}

/** Remove this trip's photos from every collection that shows them more widely than the trip does. */
export async function detachExposedFromCollections(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const level = levelOf(trip.visibility);
  const items = await db.collectionItem.findMany({ where: { photo: { tripId: trip.id } }, select: { id: true, photoId: true, collection: { select: { visibility: true, coverPhotoId: true, id: true } } } });
  const doomed = items.filter((i) => levelOf(i.collection.visibility) > level);
  if (doomed.length) {
    await db.collectionItem.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    const covers = doomed.filter((d) => d.collection.coverPhotoId === d.photoId);
    for (const c of covers) await db.collection.update({ where: { id: c.collection.id }, data: { coverPhotoId: null } });
    await db.photo.updateMany({ where: { id: { in: doomed.map((d) => d.photoId) } }, data: { updatedAt: new Date(), imageVersion: { increment: 1 } } });
  }
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/", "layout");
  redirect(`/trips/${slug}/settings?saved=1`);
}

/**
 * Take photographs off this trip. They stay in the album, with nothing claiming them, exactly as if they had never
 * been filed onto it — which is the point: a trip is an arrangement of the album, not a container things are
 * locked inside, and deleting a whole trip already leaves every photograph behind.
 *
 * Who may do it follows the same rule as taking something out of a collection. Whoever made the trip may tidy it,
 * whatever anyone else put on it; everybody else may take off the photographs they uploaded themselves.
 */
export async function removeFromTrip(slug: string, photoIds: string[]): Promise<{ removed: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, createdById: true, coverPhotoId: true } });
  if (!trip) throw new Error("Trip not found");
  const asked = z.array(z.string().min(1)).min(1).max(500).parse(photoIds);
  const list = canEditContainer(user, trip) ? asked : await editableMediaIds(user, asked);
  if (!list.length) return { removed: 0, notYours: asked.length };
  const r = await db.photo.updateMany({ where: { id: { in: list }, tripId: trip.id }, data: { tripId: null, activityId: null, activitySetById: null } });
  // A cover that is no longer on the trip is no cover at all; the album picks one for itself again.
  if (trip.coverPhotoId && list.includes(trip.coverPhotoId)) await db.trip.update({ where: { id: trip.id }, data: { coverPhotoId: null } });
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/", "layout");
  return { removed: r.count, notYours: asked.length - list.length };
}

/** Long enough to be either: a description somebody writes out, or a note for the helper to build one around. */
const DESCRIPTION_TEXT = z.string().max(4000);

/**
 * Write the trip's description by hand, from the header where it is read.
 *
 * It is still on the settings form, with everything else that shapes a trip. This is the quick path, and the one
 * that sits beside the button that asks the helper. An empty box clears it rather than storing a blank line.
 */
export async function setTripDescription(slug: string, text: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const description = DESCRIPTION_TEXT.parse(text).trim();
  await db.trip.update({ where: { id: trip.id }, data: { description: description || null, ...(await handWrittenStored(trip, description)), descriptionByHelper: descriptionStaysHelpers(trip, description) } });
  revalidatePath(`/trips/${slug}`, "layout");
}

/**
 * Show the trip's description to everyone who may open the trip, or keep it for the family. The one way a
 * members-only description becomes public: saving it, however it was edited, never does.
 */
export async function setTripDescriptionShared(slug: string, everyone: boolean): Promise<void> {
  const trip = await loadEditableTrip(slug);
  // Never the helper's description while it names somebody who may not be named there (see namesSomebodyRestricted);
  // a member's own words are theirs to show, as their captions are.
  if (everyone && trip.descriptionByHelper && (await namesSomebodyRestricted([trip.description]))) throw new Error(NAME_NOT_TO_BE_SHOWN);
  await db.trip.update({ where: { id: trip.id }, data: { descriptionMembersOnly: !everyone, descriptionSharedAt: everyone ? new Date() : null } });
  revalidatePath(`/trips/${slug}`, "layout");
}

/**
 * Ask the helper to write the trip's description, from a dozen of its photographs spread across the whole of it
 * and whatever the person pressing the button typed into the box first.
 *
 * Returned as well as saved, so what comes back can be edited before it is kept.
 */
export async function describeTripWithAi(slug: string, note?: string): Promise<string> {
  const trip = await loadEditableTrip(slug);
  const written = await writeContainerDescription("trip", trip.id, DESCRIPTION_TEXT.parse(note ?? ""));
  revalidatePath(`/trips/${slug}`, "layout");
  return written;
}
