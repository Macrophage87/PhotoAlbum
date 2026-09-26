"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { generateToken } from "@/lib/auth/tokens";
import { anthropic } from "@/lib/annotation/client";
import { annotationGates } from "@/lib/annotation/eligibility";
import { buildActivityRequest, loadActivityForDescription, parseActivityDescription } from "@/lib/annotation/activity";
import { permittedNames } from "@/lib/people/gates";
import { canEditContainer, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { activityInputFromForm, keepSeconds, localInputToInstant } from "@/lib/activities/validation";
import { deleteActivityAndRefile, reassignPhotosForActivity } from "@/lib/activities/reassign";
import { deleteTrackAndItsPositions } from "@/lib/tracks/remove";
import { fieldErrors, participantsFromForm } from "@/lib/trips/validation";
import type { ActivityType } from "@/generated/prisma/enums";
import type { ActivityFormState } from "@/components/activities/ActivityForm";
import { handWrittenDescription, handWrittenMembersOnly, judgeDescription } from "@/lib/annotation/members-only";
import { descriptionStaysHelpers } from "@/lib/annotation/helper-text";
import { namesChangedSince } from "@/lib/people/names-changed";
import { NAMES_CHANGED, withoutUnpermittedNames } from "@/lib/annotation/container";
import { forgetState } from "@/lib/people/names-changed";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import { unpermittedNameScrub } from "@/lib/people/unpermitted";
import { forgetTrackFiles } from "@/lib/tracks/files";

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
  const there = participantsFromForm(fd);
  const activity = await db.activity.create({
    data: {
      tripId: trip.id,
      title: v.title,
      type: v.type as ActivityType,
      startTime: localInputToInstant(v.start, trip.timezone),
      endTime: localInputToInstant(v.end, trip.timezone),
      description: v.description,
      descriptionMembersOnly: await handWrittenMembersOnly(null, v.description),
      // Nobody named means everybody, which is what an empty list already says.
      ...(there?.length ? { participants: { connect: there.map((id) => ({ id })) } } : {}),
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
  const existing = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, startTime: true, endTime: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionSharedAt: true, descriptionByHelper: true } });
  if (!existing) return { status: "error", message: "Activity not found" };
  // `set` reconciles to exactly what was ticked, so unticking somebody removes them; a form that never carried the
  // control at all leaves the list as it was.
  const there = participantsFromForm(fd);
  await db.activity.update({
    where: { id },
    data: {
      title: v.title,
      type: v.type as ActivityType,
      // The form shows whole minutes; an imported track's seconds survive a save that did not move them.
      startTime: keepSeconds(localInputToInstant(v.start, trip.timezone), existing.startTime),
      endTime: keepSeconds(localInputToInstant(v.end, trip.timezone), existing.endTime),
      description: v.description,
      ...(await activityHandWritten(existing, v.description)),
      descriptionByHelper: descriptionStaysHelpers(existing, v.description),
      ...(there ? { participants: { set: there.map((pid) => ({ id: pid })) } } : {}),
    },
  });
  await reassignPhotosForActivity(id);
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/activities/${id}`);
}

export async function deleteActivity(slug: string, id: string, fd: FormData): Promise<void> {
  const trip = await loadTrip(slug);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, trackId: true, track: { select: { originalFile: true } } } });
  if (!activity) return;
  const deleteTrack = fd.get("deleteTrack") === "on";
  // What was on it goes to whatever else covers its time, rather than being left loose.
  await deleteActivityAndRefile(id);
  if (deleteTrack && activity.trackId) {
    // Takes back the positions the track gave and places those photos again from the trip's other tracks.
    await deleteTrackAndItsPositions(activity.trackId);
    // The uploaded file goes only once no track refers to it: a multisport file's other legs still do.
    await forgetTrackFiles([activity.track?.originalFile]);
  }
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

/**
 * Choose (or forget) the picture the activity is known by — the one its shared link unfurls with. Arranged by
 * whoever arranges the trip, like its link and its description, and only from the activity's own photographs.
 */
export async function setActivityCover(slug: string, id: string, photoId: string | null): Promise<void> {
  const trip = await loadTrip(slug);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true } });
  if (!activity) throw new Error("Activity not found");
  if (photoId) {
    const photo = await db.photo.findFirst({ where: { id: photoId, activityId: id }, select: { id: true } });
    if (!photo) throw new Error("Photo is not on this activity");
  }
  // A photograph fronts one activity at most. One moved here from an activity it was the cover of is released there
  // first; that activity goes back to leading with its own first photograph.
  await db.$transaction([
    ...(photoId ? [db.activity.updateMany({ where: { coverPhotoId: photoId, id: { not: id } }, data: { coverPhotoId: null } })] : []),
    db.activity.update({ where: { id }, data: { coverPhotoId: photoId } }),
  ]);
  revalidatePath(`/trips/${slug}/activities/${id}`);
}


/** A description saved by hand, as stored; one held only for its trip's title keeps that reason while unchanged. */
async function activityHandWritten(before: { description: string | null; descriptionMembersOnly: boolean; descriptionTitleOnly: boolean; descriptionSharedAt: Date | null } | null, text: string | null | undefined) {
  const { descriptionMembersOnly, descriptionSharedAt, unchanged } = await handWrittenDescription(before, text);
  return { descriptionMembersOnly, descriptionSharedAt, descriptionTitleOnly: Boolean(unchanged && before?.descriptionTitleOnly && descriptionMembersOnly) };
}
/** What somebody may type into the box: a note for the helper, or the description itself. Long enough for either. */
const DESCRIPTION_TEXT = z.string().max(4000);

/**
 * Write this activity's description by hand.
 *
 * Whoever arranges the trip writes it, and what they write stands: nothing the album does later overwrites it
 * unless they ask for that themselves. An empty box clears the description rather than storing a blank one, so
 * the page goes back to offering to write one.
 */
export async function setActivityDescription(slug: string, id: string, text: string): Promise<void> {
  const trip = await loadTrip(slug);
  const description = DESCRIPTION_TEXT.parse(text).trim();
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionSharedAt: true, descriptionByHelper: true } });
  if (!activity) throw new Error("Activity not found");
  await db.activity.update({ where: { id }, data: { description: description || null, ...(await activityHandWritten(activity, description)), descriptionByHelper: descriptionStaysHelpers(activity, description) } });
  revalidatePath(`/trips/${slug}/activities/${id}`);
}

/** Show the activity's description to everyone who may open it (its link included), or keep it for the family. */
export async function setActivityDescriptionShared(slug: string, id: string, everyone: boolean): Promise<void> {
  const trip = await loadTrip(slug);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true } });
  if (!activity) throw new Error("Activity not found");
  await db.activity.update({ where: { id }, data: { descriptionMembersOnly: !everyone, descriptionTitleOnly: false, descriptionSharedAt: everyone ? new Date() : null } });
  revalidatePath(`/trips/${slug}/activities/${id}`);
}

/**
 * Ask the helper to write this activity's description, from a handful of its photographs, what the track
 * measured, and whatever the person pressing the button typed into the box first.
 *
 * A single call, made when somebody presses for it, rather than a batch: describing an outing is a thing you do
 * once and read, and the cost belongs to the press. Every rule the album already keeps applies — nothing goes if
 * the helper is switched off, an opted-out trip is refused outright, opted-out photographs are left behind, and
 * only names the family has agreed to are sent.
 *
 * The note goes with it. A photograph cannot say that it was somebody's birthday or that the point of the walk
 * was the ice cream at the end, and the person pressing the button knows both; the written answer is saved and
 * handed back so they can go on editing it by hand.
 */
export async function describeActivityWithAi(slug: string, id: string, note?: string): Promise<string> {
  const trip = await loadTrip(slug);
  const gates = await annotationGates();
  if (!gates.active) throw new Error("The AI helper is off");
  const activity = await loadActivityForDescription(id);
  if (!activity || activity.trip.id !== trip.id) throw new Error("Activity not found");
  if (activity.trip.annotationOptOut) throw new Error(`The trip ${activity.trip.title} is opted out of the AI helper`);
  if (!activity.photos.length) throw new Error("There are no photographs on this activity to describe it from");

  const requestedAt = new Date();
  const names = [...new Set((await Promise.all(activity.photos.map((p) => permittedNames(p.id)))).flat())];
  // The family's words go without the names the helper may not be told, the note beside the button included.
  // One-word forgotten names count by every photograph in it, not only the few it is shown.
  const scrub = await unpermittedNameScrub(activity.photos.map((p) => p.id), undefined, [{ kind: "activity", id }]);
  const scope = await forgottenScope({ containers: [{ kind: "activity", id }] });
  const request = await buildActivityRequest(await withoutUnpermittedNames(activity, scrub), gates.model, names, scrub(DESCRIPTION_TEXT.parse(note ?? "").trim() || null) || undefined);
  const notes = activity.photos.some((p) => p.context?.trim());
  const response = await anthropic().messages.create(request);
  console.log(`[annotate-activity] ${activity.id} model=${response.model} stop=${response.stop_reason} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  if (response.stop_reason === "refusal") throw new Error("The helper declined to describe this one");
  const parsed = parseActivityDescription(response.content as { type: string; text?: string }[]);
  if (!parsed) throw new Error("The helper's answer could not be read; try again");
  // Nobody forgotten comes back by way of the answer.
  const tombstone = await loadTombstone();
  parsed.description = tombstone.scrub(parsed.description, scope);
  // Written from names or notes, it is read by members only; see `descriptionFromMembersOnly`.
  const judged = await judgeDescription(parsed.description, {
    names,
    notes,
    // The description it replaces goes with the request, and so does the trip's title, which a link to the activity
    // alone does not open.
    previous: Boolean(activity.description && !activity.descriptionByHelper && activity.descriptionMembersOnly),
    privateTitles: activity.trip.visibility === "PUBLIC" ? [] : [activity.trip.title],
  });
  // Somebody on these photographs forgotten, renamed or no longer to be named while it was being written, or anybody
  // forgotten at all: its answer may name them, so it is not kept.
  await db.$transaction(async (tx) => {
    const forget = await forgetState(tx, tombstone.loadedAt);
    if (forget.underWay || (await namesChangedSince(activity.photos.map((p) => p.id), requestedAt))) throw new Error(NAMES_CHANGED);
    // Somebody forgotten since the forgotten names were read: read them again.
    if (forget.reload) parsed.description = (await loadTombstone()).scrub(parsed.description, await forgottenScope({ containers: [{ kind: "activity", id }] }));
    await tx.activity.update({ where: { id }, data: { description: parsed.description, descriptionMembersOnly: judged.membersOnly, descriptionTitleOnly: judged.titleOnly, descriptionTitleWords: judged.titleOnly ? (judged.titleWords ?? []) : [], descriptionSharedAt: null, descriptionByHelper: true } });
  });
  revalidatePath(`/trips/${slug}/activities/${id}`);
  return parsed.description;
}
