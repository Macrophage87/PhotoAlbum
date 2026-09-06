"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { activityInputFromForm, localInputToInstant } from "@/lib/activities/validation";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";
import { fieldErrors } from "@/lib/trips/validation";
import type { ActivityType } from "@/generated/prisma/enums";
import type { ActivityFormState } from "@/components/activities/ActivityForm";

async function loadTrip(slug: string) {
  await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, slug: true, timezone: true } });
  if (!trip) throw new Error("Trip not found");
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
