import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storage, StorageLimitError } from "@/lib/storage";
import { accessTokenFor, forgetAccessToken } from "@/lib/google/account";
import { GoogleAuthError } from "@/lib/google/oauth";
import { deletePickerSession, listPickedItems, openDownload, type PickedItem } from "@/lib/google/picker";
import { EXT_BY_MIME } from "@/lib/media/mime";
import { enqueue } from "../boss";
import { QUEUES, type GooglePickerImportJob } from "../queues";

/** accessTokenFor failed: the grant itself is in question, not one download. */
class NoToken extends Error {
  constructor(readonly reason: unknown) {
    super("no access token");
  }
}

const tokenFailure = (err: unknown) => (err instanceof GoogleAuthError && err.needsReconnect ? "Google Photos needs to be connected again." : "Could not reach Google Photos.");

/**
 * Download what a member picked in Google Photos into rows the action already created (PENDING, `sourceKind
 * GOOGLE_PICKER`), then hand each to the normal processing pipeline. Google strips location from the download, so
 * the member is told to fix places on the review screen. A failed download marks that row FAILED with the reason.
 *
 * A long queue outlives what it was started with. The access token is asked for afresh for each item (it is
 * refreshed a few minutes before it runs out), and a download Google refuses is tried once more: after a 401 with a
 * freshly refreshed token, and after a 403 with fresh addresses for the items, since a Picker item's address only
 * works for about an hour after it was listed. Only a refresh Google turns down means the member has to connect
 * again; a refused download on its own fails that item and nothing else.
 */
export async function googlePickerImport(job: GooglePickerImportJob, signal?: AbortSignal): Promise<void> {
  const rows = await db.photo.findMany({ where: { id: { in: job.photoIds }, originalPath: "pending", status: "PENDING", sourceKind: "GOOGLE_PICKER" } });
  if (rows.length === 0) return;
  const token = async () => {
    try {
      return await accessTokenFor(job.userId);
    } catch (err) {
      throw new NoToken(err);
    }
  };
  try {
    await token();
  } catch (err) {
    await db.photo.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "FAILED", error: tokenFailure(err instanceof NoToken ? err.reason : err) } });
    return;
  }
  const items = new Map(Object.entries(job.items as Record<string, PickedItem>));
  let relisted = false;
  /** Fresh addresses for every item, by asking Google for the session's items again (once per job). */
  const relist = async (): Promise<boolean> => {
    if (relisted) return false;
    relisted = true;
    const fresh = new Map((await listPickedItems(await token(), job.sessionId).catch(() => [] as PickedItem[])).map((i) => [i.id, i]));
    for (const row of rows) {
      const again = row.sourceId ? fresh.get(row.sourceId) : undefined;
      if (again) items.set(row.id, again);
    }
    return fresh.size > 0;
  };
  const download = async (rowId: string): Promise<Response> => {
    try {
      return await openDownload(await token(), items.get(rowId)!, signal);
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) throw err;
      // 401: the token went stale on the way; 403: the item's address did. Either way, one more go.
      if (err.needsReconnect) forgetAccessToken(job.userId);
      else if (!(await relist())) throw err;
      return openDownload(await token(), items.get(rowId)!, signal);
    }
  };

  const store = storage();
  for (const row of rows) {
    if (!items.has(row.id)) continue;
    if (signal?.aborted) break;
    const isVideo = row.kind === "VIDEO";
    const storageKey = `photos/${row.id}`;
    const originalPath = `${storageKey}/original.${EXT_BY_MIME[row.mimeType]}`;
    // Taken for this job, atomically: a row picked again while this job waited may have been fetched by the job that
    // picking queued, or be being fetched by it now. Whoever takes it first has it; the other passes it by.
    const claim = await db.photo.updateMany({ where: { id: row.id, originalPath: "pending", status: "PENDING" }, data: { status: "PROCESSING" } });
    if (claim.count !== 1) continue;
    /** How to recognise the row as still this job's: taken, then stored. */
    let mine: { status: "PROCESSING" | "PENDING"; originalPath: string } = { status: "PROCESSING", originalPath: "pending" };
    try {
      const res = await download(row.id);
      const { bytes } = await store.putStream(originalPath, Readable.fromWeb(res.body as never), { maxBytes: isVideo ? env().MAX_VIDEO_UPLOAD_BYTES : env().MAX_UPLOAD_BYTES });
      await db.photo.update({ where: { id: row.id }, data: { storageKey, originalPath, sizeBytes: bytes, status: "PENDING" } });
      mine = { status: "PENDING", originalPath };
      if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: row.id, tripId: row.tripId });
      else await enqueue(QUEUES.processPhoto, { photoId: row.id, tripId: row.tripId });
    } catch (err) {
      const reason = err instanceof NoToken ? tokenFailure(err.reason) : err instanceof StorageLimitError ? `Larger than ${Math.round(err.maxBytes / 1048576)} MB` : err instanceof GoogleAuthError ? "Google Photos refused the download." : "Download from Google Photos failed.";
      // Back to having no file, so picking it again fetches it rather than finding a row pointing at nothing — but
      // only while it is still this job's to put back.
      const reset = await db.photo.updateMany({ where: { id: row.id, ...mine }, data: { status: "FAILED", error: reason, storageKey: "pending", originalPath: "pending", sizeBytes: 0 } }).catch(() => ({ count: 0 }));
      if (reset.count === 1) await store.deletePrefix(storageKey).catch(() => undefined);
      if (err instanceof NoToken) {
        // The refresh itself failed (accessTokenFor marks the account when Google says the grant is gone), so
        // nothing else in this queue can be fetched either.
        await db.photo.updateMany({ where: { id: { in: rows.map((r) => r.id) }, originalPath: "pending", status: "PENDING" }, data: { status: "FAILED", error: tokenFailure(err.reason) } });
        console.error(`[google] no access token for the picker import: ${err.reason instanceof Error ? err.reason.message : String(err.reason)}`);
        break;
      }
      console.error(`[google] download of ${row.originalName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const last = await token().catch(() => null);
  if (last) await deletePickerSession(last, job.sessionId);
}
