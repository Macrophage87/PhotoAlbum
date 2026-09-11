"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { accessTokenFor, disconnectGoogleAccount } from "@/lib/google/account";
import { GoogleAuthError, googleConfigured } from "@/lib/google/oauth";
import { createPickerSession, getPickerSession, listPickedItems } from "@/lib/google/picker";
import { ALLOWED_MIMES, EXT_MIME, VIDEO_MIMES } from "@/lib/media/mime";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

export type PickerStart = { ok: true; sessionId: string; pickerUri: string; pollIntervalMs: number } | { ok: false; reconnect: boolean; message: string };
export type PickerPoll = { state: "picking" } | { state: "queued"; photoIds: string[]; skipped: number; unsupported: number } | { state: "error"; reconnect: boolean; message: string };

function fail(err: unknown): { ok: false; reconnect: boolean; message: string } {
  const reconnect = err instanceof GoogleAuthError && err.needsReconnect;
  return { ok: false, reconnect, message: reconnect ? "Google Photos needs to be connected again." : err instanceof Error ? err.message : "Google Photos is not responding." };
}

/** Open a Picker session for the member; the returned URL is where they choose photos on Google's own page. */
export async function startPickerSession(): Promise<PickerStart> {
  const user = await requireUserOrThrow();
  if (!googleConfigured()) return { ok: false, reconnect: false, message: "Google Photos is not configured." };
  try {
    const token = await accessTokenFor(user.id);
    const s = await createPickerSession(token);
    return { ok: true, sessionId: s.id, pickerUri: s.pickerUri, pollIntervalMs: s.pollIntervalMs };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Has the member finished picking? Once they have, create the rows and queue the downloads in one step, so a
 * closed tab cannot leave a finished session unimported. Items already in the album (same Google id) are skipped.
 */
export async function pollPickerSession(sessionId: string, tripId: string | null): Promise<PickerPoll> {
  const user = await requireUserOrThrow();
  try {
    const token = await accessTokenFor(user.id);
    const s = await getPickerSession(token, sessionId);
    if (!s.mediaItemsSet) return { state: "picking" };
    const items = await listPickedItems(token, sessionId);
    if (tripId && !(await db.trip.findUnique({ where: { id: tripId }, select: { id: true } }))) tripId = null;
    const existing = new Set((await db.photo.findMany({ where: { sourceKind: "GOOGLE_PICKER", sourceId: { in: items.map((i) => i.id) } }, select: { sourceId: true } })).map((r) => r.sourceId));
    const photoIds: string[] = [];
    const jobItems: Record<string, unknown> = {};
    let skipped = 0, unsupported = 0;
    for (const item of items) {
      if (existing.has(item.id)) { skipped++; continue; }
      const ext = item.filename.toLowerCase().split(".").pop() ?? "";
      let mime = item.mimeType.split(";")[0].trim();
      if (!ALLOWED_MIMES.has(mime)) mime = EXT_MIME[ext] ?? "";
      if (!ALLOWED_MIMES.has(mime)) { unsupported++; continue; }
      const created = await db.photo.create({
        data: { uploaderId: user.id, tripId, kind: VIDEO_MIMES.has(mime) ? "VIDEO" : "PHOTO", sourceKind: "GOOGLE_PICKER", sourceId: item.id, status: "PENDING", originalName: item.filename, mimeType: mime, storageKey: "pending", originalPath: "pending", sizeBytes: 0 },
        select: { id: true },
      });
      // A second poll for the same session must not create the rows twice: the unique (sourceKind, sourceId) pair is
      // not a constraint, so the check above plus a single queued job per session keeps it to one row per item.
      photoIds.push(created.id);
      jobItems[created.id] = item;
    }
    if (photoIds.length > 0) await enqueue(QUEUES.googlePickerImport, { userId: user.id, sessionId, photoIds, items: jobItems }, { expireInSeconds: 2 * 3600, retryLimit: 1, retryDelay: 60, singletonKey: `picker:${sessionId}` });
    return { state: "queued", photoIds, skipped, unsupported };
  } catch (err) {
    const f = fail(err);
    return { state: "error", reconnect: f.reconnect, message: f.message };
  }
}

/** Where the queued downloads stand, so the button can show progress and hand over to the review screen. */
export async function pickerProgress(photoIds: string[]): Promise<{ done: number; failed: number; total: number }> {
  await requireUserOrThrow();
  const rows = await db.photo.findMany({ where: { id: { in: photoIds.slice(0, 500) } }, select: { status: true } });
  return { total: photoIds.length, done: rows.filter((r) => r.status === "READY").length, failed: rows.filter((r) => r.status === "FAILED").length + (photoIds.length - rows.length) };
}

export async function disconnectGoogle(): Promise<void> {
  const user = await requireUserOrThrow();
  await disconnectGoogleAccount(user.id);
  revalidatePath("/upload");
  revalidatePath("/review");
}
