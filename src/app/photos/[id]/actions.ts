"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { editsSchema, tidyEdits } from "@/lib/images/edits";
import { requireUserOrThrow, type ViewerUser } from "@/lib/auth/viewer";
import { canEditContainer, canEditMedia, editableMediaIds, NOT_YOURS, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { trashSchema } from "@/lib/photos/trash";
import { isCoverable } from "@/lib/photos/cover";
import { guessDateFromTrip, guessDatesForTrip } from "@/lib/photos/date-guess-query";
import { dateReport, type DateReport } from "@/lib/photos/date-report";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { activityFor, onActivity } from "@/lib/activities/reassign";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { offsetMinutesInZone, photoOffsetMin, photoWallTimeToInstant } from "@/lib/time/local-day";
import { storage } from "@/lib/storage";
import { readExif, resolveTakenAt } from "@/lib/images/exif";
import { parseLatLng, placeNameOf } from "@/lib/geo/parse";
import { uploaderLabel } from "@/components/photos/toGrid";
import { addToCollection, removeFromCollection } from "@/app/collections/actions";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";
import { refreshTextEmbedding } from "@/lib/jobs/handlers/embed-photo";

/**
 * The member making this change, where the item is theirs to change. Someone else's photograph carries their
 * account of it, so only they and an admin may rewrite it; every action below goes through here first.
 */
async function editor(id: string): Promise<ViewerUser> {
  const user = await editorOrNull(id);
  if (!user) throw new Error(NOT_YOURS);
  return user;
}

/** The same, for the actions that answer with a message rather than throwing at a form. */
async function editorOrNull(id: string): Promise<ViewerUser | null> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { uploaderId: true } });
  if (!photo) return null;
  return canEditMedia(user, photo) ? user : null;
}

const updateSchema = z.object({
  title: z.string().trim().max(120).optional().transform((v) => v || null),
  caption: z.string().trim().max(1000).transform((v) => v || null),
  context: z.string().trim().max(4000).transform((v) => v || null),
  tripId: z.string().transform((v) => v || null),
  activityId: z.string().optional().transform((v) => v || null),
});

export async function updatePhoto(id: string, fd: FormData): Promise<void> {
  const user = await editor(id);
  const photo = await db.photo.findUnique({ where: { id } });
  if (!photo) throw new Error("Photo not found");
  const v = updateSchema.parse({ title: fd.get("title") ?? undefined, caption: fd.get("caption") ?? "", context: fd.get("context") ?? "", tripId: fd.get("tripId") ?? "", activityId: fd.get("activityId") ?? undefined });

  if (v.tripId && !(await db.trip.findUnique({ where: { id: v.tripId }, select: { id: true } }))) throw new Error("That trip no longer exists");

  // Which activity, and whose answer that is. "auto" hands the question back to the clock; an activity, or "" for
  // none at all, is the member's own answer, which the activity's hours then respect. Saving the form without
  // touching the field (the value it already showed) keeps whoever answered before.
  let activityId: string | null;
  let activitySetById: string | null;
  const byTime = async () => activityFor({ ...photo, activitySetById: null }, v.tripId, photo.takenAt);
  if (v.tripId !== photo.tripId || !v.tripId) {
    // A different trip (or none): the old trip's answer means nothing there, so its time decides.
    ({ activityId, activitySetById } = await byTime());
  } else if (!fd.has("activityId")) {
    ({ activityId, activitySetById } = photo);
  } else if (v.activityId === "auto") {
    // Automatic is what the form shows for a filing nobody chose, so a plain save of it changes nothing; only
    // switching to it from somebody's choice hands the photo back to the clock.
    if (photo.activitySetById) ({ activityId, activitySetById } = await byTime());
    else ({ activityId, activitySetById } = photo);
  } else if (v.activityId && !(await db.activity.count({ where: { id: v.activityId, tripId: v.tripId } }))) {
    // Deleted from under the form, or not this trip's: nothing to file it on, so nothing changes.
    ({ activityId, activitySetById } = photo);
  } else {
    activityId = v.activityId;
    activitySetById = activityId === photo.activityId && photo.activitySetById ? photo.activitySetById : user.id;
  }
  // The title field is on the photo form only; an embedded video's title is edited with its link, so it is left alone here.
  const title = fd.has("title") && photo.kind !== "EXTERNAL_VIDEO" ? v.title : photo.title;
  // Collections come from the form's checkbox group; membership is reconciled to exactly what is ticked.
  if (fd.has("collectionsPresent")) {
    const wanted = new Set(fd.getAll("collectionIds").map(String).filter(Boolean));
    const held = new Set((await db.collectionItem.findMany({ where: { photoId: id }, select: { collectionId: true } })).map((c) => c.collectionId));
    for (const cid of wanted) if (!held.has(cid)) await addToCollection(cid, [id]);
    for (const cid of held) if (!wanted.has(cid)) await removeFromCollection(cid, [id]);
  }
  // A title typed here is the member's; one left as it was keeps whoever wrote it.
  await onActivity(() => db.photo.update({ where: { id }, data: { title, ...(title !== photo.title ? { titleByHelper: title ? false : null } : {}), caption: v.caption, context: v.context, ...(v.context !== photo.context ? { contextUpdatedAt: new Date(), annotationError: null } : {}), tripId: v.tripId, activityId, activitySetById } }));
  if (title !== photo.title || v.caption !== photo.caption || v.context !== photo.context) await refreshTextEmbedding(id);
  if (v.tripId && v.tripId !== photo.tripId) await rejudgeFromAction({ tripId: v.tripId });
  revalidatePath(`/photos/${id}`);
  if (photo.tripId) revalidatePath(`/trips`, "layout");
}

/**
 * Move an item to the trash. Any member may do this and must say why; nothing is deleted, so an admin can put it
 * back exactly as it was. The item leaves every gallery, the timeline, the map, search and every share page at once,
 * which is what makes this the right button for "take that down now".
 */
export async function trashPhoto(id: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const v = trashSchema.parse({ reason: fd.get("reason"), note: fd.get("note") ?? "" });
  const photo = await db.photo.findUnique({ where: { id }, select: { trashedAt: true, trip: { select: { slug: true } } } });
  if (!photo) return;
  if (!photo.trashedAt) {
    await db.photo.update({ where: { id }, data: { trashedAt: new Date(), trashedById: user.id, trashReason: v.reason, trashNote: v.note || null } });
  }
  revalidatePath("/", "layout");
  redirect(photo.trip ? `/trips/${photo.trip.slug}/photos` : "/upload");
}

export async function reprocessPhoto(id: string): Promise<void> {
  await editor(id);
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, tripId: true, kind: true } });
  if (!photo) return;
  await db.photo.update({ where: { id }, data: { status: "PENDING", error: null } });
  // Each kind goes back through what made it: a clip through the transcoder, an embedded video's poster through the
  // renditions only (its date and trip were set with the link), everything else through the full path.
  if (photo.kind === "VIDEO") await enqueue(QUEUES.transcodeVideo, { photoId: id, tripId: photo.tripId }, { singletonKey: `transcode:${id}` });
  else if (photo.kind === "EXTERNAL_VIDEO") await enqueue(QUEUES.processPhoto, { photoId: id, mode: "renditions" });
  else await enqueue(QUEUES.processPhoto, { photoId: id, tripId: photo.tripId });
  revalidatePath(`/photos/${id}`);
}

/**
 * Make this the picture its trip is known by, from the photograph's own page.
 *
 * What this asks of a member is the trip, not the photograph: a cover is a decision about the trip, so it belongs to
 * whoever made it — who may well be leading with somebody else's picture, which is the usual case.
 */
export async function setAsCover(id: string): Promise<void> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { tripId: true, status: true, trashedAt: true, width: true, trip: { select: { slug: true, createdById: true } } } });
  if (!photo?.tripId || !photo.trip) return;
  if (!canEditContainer(user, photo.trip)) throw new Error(NOT_YOUR_CONTAINER);
  if (!isCoverable(photo)) throw new Error("Only a finished photo can be the cover");
  await db.trip.update({ where: { id: photo.tripId }, data: { coverPhotoId: id } });
  revalidatePath(`/trips/${photo.trip!.slug}`, "layout");
  revalidatePath("/");
  revalidatePath(`/photos/${id}`);
}

/**
 * Re-interpret the photo's wall-clock time in a different zone. The time shown on the camera stays
 * the same; the UTC instant moves. Then trip/activity assignment and track geotagging are redone.
 */
export async function shiftPhotoTimezone(id: string, fd: FormData): Promise<void> {
  const user = await editor(id);
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo?.takenAt) return;
  const raw = String(fd.get("offset") ?? "");
  let newOffset: number;
  if (raw === "trip") {
    if (!photo.trip) return;
    newOffset = offsetMinutesInZone(photo.takenAt, photo.trip.timezone);
  } else {
    newOffset = Number(raw);
    if (!Number.isFinite(newOffset) || Math.abs(newOffset) > 14 * 60) return;
  }
  // The clock it was shown on: its own offset, else the trip's zone (what the page displayed), not UTC.
  const oldOffset = photoOffsetMin(photo.takenAt, photo.tzOffsetMin, photo.trip?.timezone);
  const takenAt = new Date(photo.takenAt.getTime() + (oldOffset - newOffset) * 60_000);
  await applyPhotoInstant(photo, takenAt, newOffset, "MANUAL", user.id);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
}

export type DateResult = { ok: true; takenAt: string; tzOffsetMin: number; source: string; setBy: string | null } | { ok: false; message: string };

/**
 * Set the moment an item was taken from a wall-clock value typed by a member (interpreted in the item's current zone,
 * or the trip's, or UTC). The trip and activity are re-derived and, when the item had been placed from a track, it is
 * re-placed for the new time.
 */
export async function setPhotoDate(id: string, fd: FormData): Promise<DateResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(fd.get("takenAt") ?? "").trim());
  if (!m) return { ok: false, message: "Enter a date and time" };
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) };
  if (wall.year < 1800 || wall.year > 2100) return { ok: false, message: "That year looks wrong" };
  const { takenAt, tzOffsetMin } = photoWallTimeToInstant(wall, photo.tzOffsetMin, photo.trip?.timezone);
  await applyPhotoInstant(photo, takenAt, tzOffsetMin, "MANUAL", user.id, { releaseKeptOff: true });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: takenAt.toISOString(), tzOffsetMin, source: "MANUAL", setBy: uploaderLabel(user.name, user.email) };
}

/** Go back to what the camera wrote in the file: the EXIF date, resolved the same way processing does. */
export async function resetPhotoDateToCamera(id: string): Promise<DateResult> {
  if (!(await editorOrNull(id))) return { ok: false, message: NOT_YOURS };
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  const local = storage().localPath?.(photo.originalPath);
  if (!local || photo.kind !== "PHOTO") return { ok: false, message: "No camera date is available for this item" };
  const exif = await readExif(local).catch(() => null);
  const resolved = exif ? resolveTakenAt(exif, photo.trip?.timezone ?? null) : null;
  if (!resolved) return { ok: false, message: "This file carries no camera date" };
  await applyPhotoInstant(photo, resolved.takenAt, resolved.tzOffsetMin, resolved.source, null);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: resolved.takenAt.toISOString(), tzOffsetMin: resolved.tzOffsetMin, source: resolved.source, setBy: null };
}


export type PlaceResult = { ok: true; lat: number | null; lng: number | null; gpsSource: string | null; setBy: string | null; placeName: string | null } | { ok: false; message: string };

/** Pin an item to a spot a member chose (a click on the map or a looked-up address). Never touched by later geotagging. */
export async function setPhotoPlace(id: string, fd: FormData): Promise<PlaceResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const pos = parseLatLng(fd.get("lat"), fd.get("lng"));
  if (!pos) return { ok: false, message: "Enter a latitude between -90 and 90 and a longitude between -180 and 180" };
  const name = placeNameOf(fd.get("name"));
  const r = await db.photo.updateMany({ where: { id }, data: { lat: pos.lat, lng: pos.lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: name } });
  if (!r.count) return { ok: false, message: "Photo not found" };
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: pos.lat, lng: pos.lng, gpsSource: "MANUAL", setBy: uploaderLabel(user.name, user.email), placeName: name };
}

/**
 * Accept the helper's guess as the item's place. The position does not move; it stops being a guess, which means a
 * track imported later no longer replaces it, and the album records who agreed to it.
 */
export async function confirmPlaceEstimate(id: string): Promise<PlaceResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const photo = await db.photo.findUnique({ where: { id }, select: { lat: true, lng: true, gpsSource: true, placeName: true, placeEstimateName: true, placeEstimateMembersOnly: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  if (photo.gpsSource !== "ESTIMATE" || photo.lat === null || photo.lng === null) return { ok: false, message: "There is no estimated place to accept" };
  // The helper's name for the place becomes the item's own, so accepting a guess does not turn it back into
  // coordinates — unless the name is the family's (it came from the notes, or names somebody): the place name is
  // shown to anybody who may see the item, so that one is left for a member to write or look up themselves.
  const name = photo.placeName ?? (photo.placeEstimateMembersOnly ? null : photo.placeEstimateName);
  await db.photo.update({ where: { id }, data: { gpsSource: "MANUAL", placeSetById: user.id, placeName: name } });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: photo.lat, lng: photo.lng, gpsSource: "MANUAL", setBy: uploaderLabel(user.name, user.email), placeName: name };
}

/**
 * Take an item's place away, for good as far as the album's own tools go.
 *
 * Who removed it is kept (a place set by hand with no position): a removal is a choice as much as a pin is, and
 * without it nothing could tell "taken away" from "never had one". With it, no track, re-process, Takeout repair or
 * guess from the helper puts a position back — the home address on a public trip, say. Only a member setting a
 * place by hand gives it one again. What the helper recognised goes with it, but the record that it was asked is
 * kept, so a later backfill does not ask again either.
 */
export async function clearPhotoPlace(id: string): Promise<PlaceResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  await db.photo.update({ where: { id }, data: { lat: null, lng: null, altitude: null, gpsSource: null, placeSetById: user.id, placeName: null, placeEstimateName: null, placeEstimateConfidence: null, placeEstimateRadiusM: null, placeEstimatePrecision: null, placeEstimateNote: null, placeEstimateMembersOnly: false } });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: null, lng: null, gpsSource: null, setBy: uploaderLabel(user.name, user.email), placeName: null };
}

export type EditResult = { ok: true; edited: boolean } | { ok: false; message: string };

/**
 * Save darkroom instructions. Nothing is written over: the renditions are made again from the untouched original,
 * so reverting is simply forgetting them. Only the member who uploaded the item, or an admin, may do this — an
 * edit changes what everyone else sees, and the uploader is who the album holds responsible for the picture.
 */
export async function savePhotoEdits(id: string, raw: unknown): Promise<EditResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const photo = await db.photo.findUnique({ where: { id }, select: { kind: true, status: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  if (photo.kind !== "PHOTO") return { ok: false, message: "Only photos can be edited here" };
  const parsed = editsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Those edits do not make sense" };
  const edits = tidyEdits(parsed.data);
  await db.photo.update({
    where: { id },
    data: edits ? { edits, editedAt: new Date(), editedById: user.id } : { edits: Prisma.DbNull, editedAt: null, editedById: null },
  });
  await enqueue(QUEUES.processPhoto, { photoId: id, mode: "renditions" }, { singletonKey: `renditions:${id}`, singletonSeconds: 5, singletonNextSlot: true });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, edited: Boolean(edits) };
}

/** Put the item back exactly as it was uploaded. The original never changed, so this only forgets the instructions. */
export async function revertPhotoEdits(id: string): Promise<EditResult> {
  return savePhotoEdits(id, {});
}

export type DateGuessResult = { ok: true; takenAt: string; tzOffsetMin: number; source: string; setBy: string | null } | { ok: false; message: string };

/**
 * Take the date the rest of the trip points at. It is recorded as set by hand, by the member who accepted it, because
 * that is what happened: the album offered a reading of the neighbours and a person agreed with it.
 */
export async function setDateFromNeighbours(id: string): Promise<DateGuessResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const guess = await guessDateFromTrip(id);
  if (!guess) return { ok: false, message: "The other photos on this trip do not say anything about this one" };
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, tripId: true, gpsSource: true, uploaderId: true, activityId: true, activitySetById: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  await applyPhotoInstant(photo, guess.takenAt, guess.tzOffsetMin, "MANUAL", user.id);
  return { ok: true, takenAt: guess.takenAt.toISOString(), tzOffsetMin: guess.tzOffsetMin, source: "MANUAL", setBy: uploaderLabel(user.name, user.email) };
}

/** The same across a whole trip, for a box of scans or a folder an editor stripped on the way out. */
export async function setTripDatesFromNeighbours(tripId: string): Promise<number> {
  const user = await requireUserOrThrow();
  const guesses = await guessDatesForTrip(tripId);
  // A sweep over a whole trip only touches the items this member may change.
  const mine = new Set(await editableMediaIds(user, guesses.map((g) => g.id)));
  let n = 0;
  for (const g of guesses) {
    if (!mine.has(g.id)) continue;
    const photo = await db.photo.findUnique({ where: { id: g.id }, select: { id: true, tripId: true, gpsSource: true, uploaderId: true, activityId: true, activitySetById: true } });
    if (!photo) continue;
    await applyPhotoInstant(photo, g.guess.takenAt, g.guess.tzOffsetMin, "MANUAL", user.id);
    n += 1;
  }
  revalidatePath("/trips", "layout");
  return n;
}

/** Where this item's date came from and what else disagrees, for the troubleshooting panel. */
export async function loadDateReport(id: string): Promise<DateReport | null> {
  await requireUserOrThrow();
  return dateReport(id);
}

/** Take one of the readings the report lists, recorded as set by the member who agreed with it. */
export async function applyReportedDate(id: string, iso: string): Promise<DateGuessResult> {
  const user = await editorOrNull(id);
  if (!user) return { ok: false, message: NOT_YOURS };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { ok: false, message: "That is not a date" };
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, tripId: true, gpsSource: true, uploaderId: true, activityId: true, activitySetById: true, tzOffsetMin: true, trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  // The one rule for a photograph's clock: its own offset, else the trip's zone at that instant, else UTC.
  const offset = photoOffsetMin(at, photo.tzOffsetMin, photo.trip?.timezone);
  await applyPhotoInstant(photo, at, offset, "MANUAL", user.id, { releaseKeptOff: true });
  return { ok: true, takenAt: at.toISOString(), tzOffsetMin: offset, source: "MANUAL", setBy: uploaderLabel(user.name, user.email) };
}

/**
 * Forget the picture a scan shows in the grids, so the next member to open it takes a new one.
 *
 * A scan's tile is a still of what somebody's browser drew, taken once and kept — which is fine until the still is
 * wrong. A browser asked at the wrong moment, or one that could not fetch the colours baked into the scan, hands
 * back a blank rectangle, and the album has no way of knowing it was looking at nothing. This is the way back:
 * whoever may change the item can throw the still away, and the viewer takes another the next time it is opened.
 */
export async function retakeScanStill(id: string): Promise<void> {
  const user = await editor(id);
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, kind: true } });
  if (!photo || photo.kind !== "SCAN") throw new Error("That is not a 3D scan");
  await db.photo.update({ where: { id: photo.id }, data: { renditions: Prisma.DbNull, editedById: user.id } });
  revalidatePath("/", "layout");
}
