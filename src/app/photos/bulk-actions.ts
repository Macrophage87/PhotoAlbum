"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { trashSchema } from "@/lib/photos/trash";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { applyPhotoInstant, requestGeotag } from "@/lib/photos/apply-date";
import { datePlanSchema, isEmptyPlan, planDate } from "@/lib/photos/bulk-date";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { editableMediaIds } from "@/lib/auth/ownership";
import { Prisma } from "@/generated/prisma/client";
import { editsSchema, tidyEdits, type PhotoEdits } from "@/lib/images/edits";
import type { AutoColourResult } from "@/lib/photos/auto-colour";

const ids = z.array(z.string().min(1)).min(1).max(500);

export async function bulkAssignActivity(photoIds: string[], activityId: string | null): Promise<void> {
  const user = await requireUserOrThrow();
  // A selection reaches across the family's photos; a bulk change touches only the part of it this member may change.
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
  if (activityId) {
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { tripId: true } });
    if (!activity) return;
    await db.photo.updateMany({ where: { id: { in: list }, tripId: activity.tripId }, data: { activityId } });
  } else {
    await db.photo.updateMany({ where: { id: { in: list } }, data: { activityId: null } });
  }
  revalidatePath("/trips", "layout");
}

export async function bulkMoveToTrip(photoIds: string[], tripId: string | null): Promise<void> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
  if (tripId && !(await db.trip.findUnique({ where: { id: tripId }, select: { id: true } }))) return;
  await db.photo.updateMany({ where: { id: { in: list } }, data: { tripId, activityId: null } });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
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
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
  revalidatePath("/", "layout");
  return r.count;
}

/** Where a photograph was before it was moved, so the move can be taken back. */
export type PlaceBefore = { id: string; lat: number | null; lng: number | null; gpsSource: "EXIF" | "TRACK" | "MANUAL" | "SIDECAR" | "ESTIMATE" | null; placeName: string | null };

const beforeSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      lat: z.number().min(-90).max(90).nullable(),
      lng: z.number().min(-180).max(180).nullable(),
      gpsSource: z.enum(["EXIF", "TRACK", "MANUAL", "SIDECAR", "ESTIMATE"]).nullable(),
      placeName: z.string().max(200).nullable(),
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
export async function placePhotos(photoIds: string[], lat: number, lng: number, name?: string | null): Promise<{ count: number; before: PlaceBefore[] }> {
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return { count: 0, before: [] };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const before = await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, lat: true, lng: true, gpsSource: true, placeName: true } });
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
  return { count: r.count, before };
}

/** Take a move back: each photograph returns to exactly where it was, whoever or whatever had put it there. */
export async function restorePlaces(entries: PlaceBefore[]): Promise<number> {
  const user = await requireUserOrThrow();
  const all = beforeSchema.parse(entries);
  const mine = new Set(await editableMediaIds(user, all.map((e) => e.id)));
  const allowed = all.filter((e) => mine.has(e.id));
  await db.$transaction(
    allowed.map((e) =>
      db.photo.update({
        where: { id: e.id },
        data: { lat: e.lat, lng: e.lng, gpsSource: e.lat === null ? null : e.gpsSource, placeName: e.placeName, ...(e.gpsSource === "MANUAL" ? {} : { placeSetById: null }) },
      }),
    ),
  );
  return allowed.length;
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
    select: { id: true, tripId: true, gpsSource: true, activityId: true, activitySetById: true, takenAt: true, tzOffsetMin: true, caption: true, title: true, originalName: true, trip: { select: { timezone: true } } },
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
      label: photo.caption ?? photo.title ?? photo.originalName,
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
