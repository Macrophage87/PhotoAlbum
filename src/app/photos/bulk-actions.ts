"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { trashSchema } from "@/lib/photos/trash";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { applyPhotoInstant, requestGeotag } from "@/lib/photos/apply-date";
import { onActivity, refileByClock } from "@/lib/activities/reassign";
import { forgetPlaces, placesFor, rememberPlaces } from "@/lib/photos/place-undo";
import { datePlanSchema, isEmptyPlan, planDate } from "@/lib/photos/bulk-date";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { editableMediaIds } from "@/lib/auth/ownership";
import { Prisma } from "@/generated/prisma/client";
import { editsSchema, tidyEdits, type PhotoEdits } from "@/lib/images/edits";
import type { AutoColourResult } from "@/lib/photos/auto-colour";
import { readableTitle } from "@/lib/photos/readable-text";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";
import { placeFromMembersOnly } from "@/lib/annotation/members-only";
import { noteRelaxedRelease } from "@/lib/annotation/relaxed-release";

const ids = z.array(z.string().min(1)).min(1).max(500);

/**
 * File a trip's selection on one of its activities, or on none. Either way it is a member's choice, recorded as one,
 * so neither the activity's hours nor a corrected date undo it later.
 */
export async function bulkAssignActivity(photoIds: string[], activityId: string | null): Promise<void> {
  const user = await requireUserOrThrow();
  // A selection reaches across the family's photos; a bulk change touches only the part of it this member may change.
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
  if (activityId) {
    const activity = await db.activity.findUnique({ where: { id: activityId, trip: { deletingAt: null } }, select: { tripId: true } });
    if (!activity) return;
    await onActivity(() => db.photo.updateMany({ where: { id: { in: list }, tripId: activity.tripId }, data: { activityId, activitySetById: user.id } }));
  } else {
    // Only a photograph on a trip has activities to stay off.
    await db.photo.updateMany({ where: { id: { in: list }, tripId: { not: null } }, data: { activityId: null, activitySetById: user.id } });
  }
  revalidatePath("/trips", "layout");
}

export async function bulkMoveToTrip(photoIds: string[], tripId: string | null): Promise<void> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
  if (tripId && !(await db.trip.findUnique({ where: { id: tripId, deletingAt: null }, select: { id: true } }))) return;
  // A new trip is a fresh start: whatever was chosen about the old trip's activities means nothing on this one, so
  // each is filed by its time, as an upload into the trip would be. Those already on it stay exactly as they are.
  const moving = (await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, tripId: true } })).filter((p) => p.tripId !== tripId).map((p) => p.id);
  await db.photo.updateMany({ where: { id: { in: moving } }, data: { tripId, activityId: null, activitySetById: null } });
  if (tripId) await refileByClock(tripId, { id: { in: moving } });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  if (tripId) await rejudgeFromAction({ tripId });
  // Onto no trip: its words are shown at the album's level now (see rejudgeNameCheck).
  else if (moving.length) await rejudgeFromAction({ recheck: {} });
  revalidatePath("/", "layout");
}

/** Move a selection to the trash, all for the same reason. Nothing is deleted; an admin decides what happens next. */
export async function bulkTrash(photoIds: string[], reason: string, note: string): Promise<number> {
  const user = await requireUserOrThrow();
  const list = ids.parse(photoIds);
  const v = trashSchema.parse({ reason, note });
  const r = await db.photo.updateMany({ where: { id: { in: list }, trashedAt: null }, data: { trashedAt: new Date(), trashedById: user.id, trashReason: v.reason, trashNote: v.note || null } });
  revalidatePath("/", "layout");
  return r.count;
}

/** Pin every selected item to one spot (a group of prints from the same place). */
export async function bulkSetPlace(photoIds: string[], lat: number, lng: number, name?: string | null): Promise<number> {
  return (await setPlaces(photoIds, lat, lng, name)).length;
}

/**
 * The same, answering which of them were placed: only the member's own (or anything, for an admin) that are still
 * in the album. The map a selection was dropped on moves exactly these, so a pin that was not saved stays put.
 */
export async function placeOnMap(photoIds: string[], lat: number, lng: number): Promise<string[]> {
  return setPlaces(photoIds, lat, lng, null);
}

async function setPlaces(photoIds: string[], lat: number, lng: number, name: string | null | undefined): Promise<string[]> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const placed = await db.$transaction(async (tx) => {
    const found = (await tx.photo.findMany({ where: { id: { in: list } }, select: { id: true } })).map((p) => p.id);
    if (found.length) await tx.photo.updateMany({ where: { id: { in: found } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
    return found;
  });
  revalidatePath("/", "layout");
  return placed;
}

/**
 * Where a photograph was before it was moved, so the move can be taken back. `removedByHand` says it had no place
 * because a member removed it; who that was stays on the server (see place-undo).
 */
export type PlaceBefore = { id: string; lat: number | null; lng: number | null; gpsSource: "EXIF" | "TRACK" | "MANUAL" | "SIDECAR" | "ESTIMATE" | null; placeName: string | null; removedByHand: boolean };

const beforeSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      lat: z.number().min(-90).max(90).nullable(),
      lng: z.number().min(-180).max(180).nullable(),
      gpsSource: z.enum(["EXIF", "TRACK", "MANUAL", "SIDECAR", "ESTIMATE"]).nullable(),
      placeName: z.string().max(200).nullable(),
      removedByHand: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(500);

/**
 * Put a selection on one spot, and hand back where each of them was.
 *
 * The same as `bulkSetPlace` apart from the answer: the placing screen offers "Undo" straight afterwards, because on a
 * phone the likeliest mistake is a tap a street away from the one meant, and the fix should be one press.
 * Nothing is revalidated: the screen keeps its own list, and every page that shows a position is built afresh when
 * it is next opened. Rebuilding this one underneath would only make the phone fetch every link on it again.
 */
export async function placePhotos(photoIds: string[], lat: number, lng: number, name?: string | null): Promise<{ count: number; before: PlaceBefore[]; undo: string | null }> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return { count: 0, before: [], undo: null };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const rows = await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, lat: true, lng: true, altitude: true, gpsSource: true, placeName: true, placeSetById: true } });
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
  const before = rows.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, gpsSource: p.gpsSource, placeName: p.placeName, removedByHand: p.lat === null && p.placeSetById !== null }));
  return { count: r.count, before, undo: rememberPlaces(user.id, rows, { lat, lng }) };
}

/**
 * Take a move back: each photograph returns to exactly where it was, whoever or whatever had put it there —
 * including "nowhere, because somebody removed it", which must stay removed rather than become a gap the album
 * fills in — with the height the camera recorded and whose choice it was. All of that comes from what the server
 * noted when the move was made (`undo`), never from the browser: the entries only say which to take back.
 * Without the note (a restart, or an hour gone) the browser's positions are put back, but as the member pressing
 * Undo placing them by hand, since nothing else it says about them can be checked.
 *
 * Only a photograph still exactly where the move left it is taken back: on the pin, placed by hand, by this member.
 * Anything that changed in between — an admin clearing the place, somebody placing it again, a track arriving — is
 * newer than the move, and an Undo pressed afterwards leaves it as it is and says how many it left. `to` is where
 * the move put them, as the screen knows it; the server's note says the same and is preferred.
 *
 * A guess that comes back is judged again as it is written: while it was covered by the move, the notes, the names
 * the album knows or its own titles may have changed, and a guess the rejudging pass has not reached must not show
 * its name and evidence to visitors in the meantime (see `placeFromMembersOnly`).
 */
/** Where each photograph was put back to, as it was written, so the screen shows what the album now says. */
export type PlaceRestored = { id: string; lat: number | null; lng: number | null; gpsSource: PlaceBefore["gpsSource"] };

export async function restorePlaces(entries: PlaceBefore[], undo?: string | null, to?: { lat: number; lng: number } | null): Promise<{ restored: PlaceRestored[]; changed: number }> {
  const user = await requireUserOrThrow();
  const all = beforeSchema.parse(entries);
  const mine = new Set(await editableMediaIds(user, all.map((e) => e.id)));
  const allowed = all.filter((e) => mine.has(e.id));
  const noted = placesFor(undo, user.id);
  const pin = noted?.to ?? (to && Number.isFinite(to.lat) && Number.isFinite(to.lng) ? { lat: to.lat, lng: to.lng } : null);
  const restored = (e: (typeof allowed)[number]) => {
    const was = noted?.places.get(e.id);
    if (was) return { lat: was.lat, lng: was.lng, altitude: was.altitude, gpsSource: was.gpsSource, placeName: was.placeName, placeSetById: was.placeSetById };
    if (e.lat === null) return { lat: null, lng: null, altitude: null, gpsSource: null, placeName: e.placeName, placeSetById: e.removedByHand ? user.id : null };
    return { lat: e.lat, lng: e.lng, altitude: null, gpsSource: "MANUAL" as const, placeName: e.placeName, placeSetById: user.id };
  };
  // Where the move left each one: placed by hand, by the member taking it back, on the pin when it is known.
  const asLeft = { gpsSource: "MANUAL" as const, placeSetById: user.id, ...(pin ? { lat: pin.lat, lng: pin.lng } : {}) };
  const writes = await Promise.all(allowed.map(async (e) => {
    const data = restored(e);
    return { id: e.id, data: { ...data, ...(data.gpsSource === "ESTIMATE" ? await judgedGuess(e.id) : {}) } };
  }));
  // Each write is its own check: what is still as the move left it comes back, and the rest is counted.
  const counts = await db.$transaction(writes.map((w) => db.photo.updateMany({ where: { id: w.id, ...asLeft }, data: w.data })));
  const written: PlaceRestored[] = writes.filter((_, i) => counts[i].count > 0).map((w) => ({ id: w.id, lat: w.data.lat, lng: w.data.lng, gpsSource: w.data.gpsSource }));
  // A guess shown again only because a relaxed excuse lets it be: marked (relaxed-release.ts).
  for (const w of written) if (w.gpsSource === "ESTIMATE") await noteRelaxedRelease(w.id);
  const changed = writes.length - written.length;
  forgetPlaces(noted ? undo : null);
  return { restored: written, changed };
}

/** A guess about to be shown again, held back from visitors if it would be now; never made visible here. */
async function judgedGuess(photoId: string): Promise<{ placeEstimateMembersOnly?: true }> {
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { placeEstimateName: true, placeEstimateNote: true, placeEstimateMembersOnly: true, context: true } });
  if (!p || p.placeEstimateMembersOnly) return {};
  return (await placeFromMembersOnly(photoId, { name: p.placeEstimateName, evidence: p.placeEstimateNote }, p.context, null)) ? { placeEstimateMembersOnly: true } : {};
}

/** The instructions stored on a row, where they still make sense; anything unreadable is treated as none. */
function editsOf(raw: unknown): PhotoEdits | null {
  const parsed = editsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const dateOrder = [{ takenAt: "asc" as const }, { originalName: "asc" as const }];

type PlannedRow = { id: string; label: string; before: { at: string; tzOffsetMin: number } | null; after: { at: string; tzOffsetMin: number } };

/** Read the selection, work out what the plan does to each item, and hand back both the rows and what was skipped. */
async function planSelection(user: { id: string; role: "ADMIN" | "MEMBER" }, photoIds: string[], plan: unknown) {
  const asked = ids.parse(photoIds);
  const list = await editableMediaIds(user, asked);
  const notYours = asked.length - list.length;
  const p = datePlanSchema.parse(plan);
  const photos = await db.photo.findMany({
    where: { id: { in: list }, trashedAt: null },
    select: { id: true, tripId: true, gpsSource: true, uploaderId: true, activityId: true, activitySetById: true, takenAt: true, tzOffsetMin: true, caption: true, title: true, membersTitle: true, originalName: true, trip: { select: { timezone: true } } },
    orderBy: dateOrder,
  });
  const rows: (PlannedRow & { photo: (typeof photos)[number] })[] = [];
  let skipped = 0;
  photos.forEach((photo, index) => {
    const fallbackOffsetMin = photo.trip ? offsetMinutesInZone(photo.takenAt ?? new Date(), photo.trip.timezone) : 0;
    const next = isEmptyPlan(p) ? null : planDate(photo, p, { index, fallbackOffsetMin });
    if (!next) { skipped += 1; return; }
    rows.push({
      photo,
      id: photo.id,
      label: photo.caption ?? readableTitle(photo, true) ?? photo.originalName,
      before: photo.takenAt ? { at: photo.takenAt.toISOString(), tzOffsetMin: photo.tzOffsetMin ?? fallbackOffsetMin } : null,
      after: { at: next.takenAt.toISOString(), tzOffsetMin: next.tzOffsetMin },
    });
  });
  return { rows, skipped, notYours };
}

/**
 * What a date correction would do, before it does it. A run of wrong dates is usually spotted on a timeline, where
 * the thing a member wants to check is that the corrected dates land where they remember being — so they read the
 * before and after of a few of them rather than the arithmetic.
 */
export async function previewBulkDate(photoIds: string[], plan: unknown): Promise<{ rows: PlannedRow[]; count: number; skipped: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const { rows, skipped, notYours } = await planSelection(user, photoIds, plan);
  return { rows: rows.slice(0, 6).map((row) => ({ id: row.id, label: row.label, before: row.before, after: row.after })), count: rows.length, skipped, notYours };
}

/** Apply that correction. Items the plan cannot touch (a shift needs a date to shift) are left exactly as they were. */
export async function bulkSetDate(photoIds: string[], plan: unknown): Promise<{ n: number; skipped: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const { rows, skipped, notYours } = await planSelection(user, photoIds, plan);
  const trips = new Set<string>();
  for (const row of rows) {
    const tripId = await applyPhotoInstant(row.photo, new Date(row.after.at), row.after.tzOffsetMin, "MANUAL", user.id, { geotag: false });
    if (tripId) trips.add(tripId);
  }
  // One re-geotag per trip rather than one per photo: the job walks the whole trip anyway.
  for (const tripId of trips) await requestGeotag(tripId);
  revalidatePath("/", "layout");
  return { n: rows.length, skipped, notYours };
}

/**
 * Run the darkroom's auto levels over a whole selection.
 *
 * A box of scans, or an afternoon indoors, comes out flat in the same way across every frame, and correcting them
 * one at a time is the sort of chore that means it never gets done. Nothing is written over: "auto" is an
 * instruction stored beside the picture, and every rendition is made again from the untouched original — so the
 * whole batch can be handed back in one press, and the file that was uploaded is still exactly the file that was
 * uploaded.
 *
 * The levels themselves are worked out per photograph at the moment it is rendered, not once for the batch: a
 * sunset and a kitchen need different corrections, and one average across both would spoil each.
 */
export async function bulkAutoColour(photoIds: string[]): Promise<AutoColourResult> {
  const user = await requireUserOrThrow();
  const asked = ids.parse(photoIds);
  const mine = await editableMediaIds(user, asked);
  const photos = await db.photo.findMany({
    where: { id: { in: mine }, trashedAt: null },
    select: { id: true, kind: true, status: true, edits: true },
  });
  // A clip, an embedded video or a 3D scan has no levels to stretch; neither has anything still processing.
  const usable = photos.filter((p) => p.kind === "PHOTO" && p.status === "READY");
  const changed: string[] = [];
  let already = 0;
  for (const photo of usable) {
    const current = editsOf(photo.edits);
    if (current?.auto) { already += 1; continue; }
    // Everything else a member set — a crop, a turn, a warmth — is left exactly as it is.
    const next = tidyEdits({ ...(current ?? {}), auto: true });
    await db.photo.update({ where: { id: photo.id }, data: { edits: next ?? Prisma.DbNull, editedAt: new Date(), editedById: user.id } });
    await enqueue(QUEUES.processPhoto, { photoId: photo.id, mode: "renditions" }, { singletonKey: `renditions:${photo.id}`, singletonSeconds: 5, singletonNextSlot: true });
    changed.push(photo.id);
  }
  if (changed.length) revalidatePath("/", "layout");
  return { changed, already, notPhotos: photos.length - usable.length, notYours: asked.length - mine.length };
}

/** Hand the batch back: forget the auto-levels instruction on exactly the items it was just set on. */
export async function undoAutoColour(photoIds: string[]): Promise<number> {
  const user = await requireUserOrThrow();
  const mine = await editableMediaIds(user, ids.parse(photoIds));
  const photos = await db.photo.findMany({ where: { id: { in: mine } }, select: { id: true, edits: true } });
  let n = 0;
  for (const photo of photos) {
    const current = editsOf(photo.edits);
    if (!current?.auto) continue;
    const next = tidyEdits({ ...current, auto: false });
    await db.photo.update({
      where: { id: photo.id },
      data: next ? { edits: next, editedAt: new Date(), editedById: user.id } : { edits: Prisma.DbNull, editedAt: null, editedById: null },
    });
    await enqueue(QUEUES.processPhoto, { photoId: photo.id, mode: "renditions" }, { singletonKey: `renditions:${photo.id}`, singletonSeconds: 5, singletonNextSlot: true });
    n += 1;
  }
  if (n) revalidatePath("/", "layout");
  return n;
}
