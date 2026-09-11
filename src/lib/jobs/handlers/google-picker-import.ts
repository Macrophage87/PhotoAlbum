import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storage, StorageLimitError } from "@/lib/storage";
import { accessTokenFor } from "@/lib/google/account";
import { GoogleAuthError } from "@/lib/google/oauth";
import { deletePickerSession, openDownload, type PickedItem } from "@/lib/google/picker";
import { EXT_BY_MIME } from "@/lib/media/mime";
import { enqueue } from "../boss";
import { QUEUES, type GooglePickerImportJob } from "../queues";

/**
 * Download what a member picked in Google Photos into rows the action already created (PENDING, `sourceKind
 * GOOGLE_PICKER`), then hand each to the normal processing pipeline. Google strips location from the download, so
 * the member is told to fix places on the review screen. A failed download marks that row FAILED with the reason.
 */
export async function googlePickerImport(job: GooglePickerImportJob): Promise<void> {
  const rows = await db.photo.findMany({ where: { id: { in: job.photoIds }, originalPath: "pending", status: "PENDING", sourceKind: "GOOGLE_PICKER" } });
  if (rows.length === 0) return;
  let token: string;
  try {
    token = await accessTokenFor(job.userId);
  } catch (err) {
    const reason = err instanceof GoogleAuthError && err.needsReconnect ? "Google Photos needs to be connected again." : "Could not reach Google Photos.";
    await db.photo.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "FAILED", error: reason } });
    return;
  }
  const store = storage();
  for (const row of rows) {
    const item = job.items[row.id];
    if (!item) continue;
    const isVideo = row.kind === "VIDEO";
    const storageKey = `photos/${row.id}`;
    const originalPath = `${storageKey}/original.${EXT_BY_MIME[row.mimeType]}`;
    try {
      const res = await openDownload(token, item as PickedItem);
      const { bytes } = await store.putStream(originalPath, Readable.fromWeb(res.body as never), { maxBytes: isVideo ? env().MAX_VIDEO_UPLOAD_BYTES : env().MAX_UPLOAD_BYTES });
      await db.photo.update({ where: { id: row.id }, data: { storageKey, originalPath, sizeBytes: bytes } });
      if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: row.id, tripId: row.tripId });
      else await enqueue(QUEUES.processPhoto, { photoId: row.id, tripId: row.tripId });
    } catch (err) {
      await store.deletePrefix(storageKey).catch(() => undefined);
      const reason = err instanceof StorageLimitError ? `Larger than ${Math.round(err.maxBytes / 1048576)} MB` : err instanceof GoogleAuthError ? (err.needsReconnect ? "Google Photos needs to be connected again." : err.message) : "Download from Google Photos failed.";
      await db.photo.update({ where: { id: row.id }, data: { status: "FAILED", error: reason } }).catch(() => undefined);
      console.error(`[google] download of ${row.originalName} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof GoogleAuthError && err.needsReconnect) {
        await db.photo.updateMany({ where: { id: { in: rows.map((r) => r.id) }, originalPath: "pending", status: "PENDING" }, data: { status: "FAILED", error: "Google Photos needs to be connected again." } });
        break;
      }
    }
  }
  await deletePickerSession(token, job.sessionId);
}
