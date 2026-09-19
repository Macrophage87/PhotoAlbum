"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { generateToken } from "@/lib/auth/tokens";
import { canEditContainer, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { activityInputFromForm, localInputToInstant } from "@/lib/activities/validation";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";
import { fieldErrors } from "@/lib/trips/validation";
import type { ActivityType } from "@/generated/prisma/enums";
import type { ActivityFormState } from "@/components/activities/ActivityForm";

/** An activity is part of the shape of a trip, so it is the trip's maker (and admins) who arrange them. */
async function loadTrip(slug: string) {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, slug: true, timezone: true, createdById: true } });
  if (!trip) throw new Error("Trip not found");
  if (!canEditContainer(user, trip)) throw new Error(NOT_YOUR_CONTAINER);
  return trip;
}

export async function createActivity(slug: string, _prev: ActivityFormState, fd: FormData): Promise<ActivityFormState> {
  const trip = await loadTrip(slug);
  const parsed = activityInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const activity = await db.activity.create({
    data: {
      tripId: trip.id,
      title: v.title,
      type: v.type as ActivityType,
      startTime: localInputToInstant(v.start, trip.timezone),
      endTime: localInputToInstant(v.end, trip.timezone),
      description: v.description,
    },
  });
  await reassignPhotosForActivity(activity.id);
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/activities/${activity.id}`);
}

export async function updateActivity(slug: string, id: string, _prev: ActivityFormState, fd: FormData): Promise<ActivityFormState> {
  const trip = await loadTrip(slug);
  const parsed = activityInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const existing = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true } });
  if (!existing) return { status: "error", message: "Activity not found" };
  await db.activity.update({
    where: { id },
    data: { title: v.title, type: v.type as ActivityType, startTime: localInputToInstant(v.start, trip.timezone), endTime: localInputToInstant(v.end, trip.timezone), description: v.description },
  });
  await reassignPhotosForActivity(id);
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/activities/${id}`);
}

export async function deleteActivity(slug: string, id: string, fd: FormData): Promise<void> {
  const trip = await loadTrip(slug);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, trackId: true } });
  if (!activity) return;
  const deleteTrack = fd.get("deleteTrack") === "on";
  await db.activity.delete({ where: { id } });
  if (deleteTrack && activity.trackId) await db.track.delete({ where: { id: activity.trackId } }).catch(() => {});
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/activities`);
}

/**
 * Make, replace or withdraw the secret link to one activity.
 *
 * An afternoon's walk is the piece of a trip somebody actually wants to send — the track, its stats and the
 * photographs taken on it — without handing over the fortnight around it. So an activity carries its own link,
 * quite apart from the trip's visibility: making one here opens nothing else of the trip, and a private trip stays
 * private to everyone who has not been sent this.
 *
 * Whoever arranges the trip's activities arranges this too. Replacing the link retires the old one at once, and
 * touching the photographs behind it changes their rendition URLs so that a private cache keyed on the old link
 * stops matching.
 */
export async function setActivityShare(slug: string, id: string, on: boolean): Promise<void> {
  const trip = await loadTrip(slug);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true } });
  if (!activity) throw new Error("Activity not found");
  await db.activity.update({ where: { id }, data: { shareToken: on ? generateToken() : null } });
  await db.photo.updateMany({ where: { activityId: id }, data: { updatedAt: new Date() } });
  revalidatePath(`/trips/${slug}/activities/${id}`);
}
