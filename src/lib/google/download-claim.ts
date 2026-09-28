/**
 * A Picker download that has held its row (PROCESSING, still no file) this long was lost with its worker: a download
 * gives up after ten minutes. The row is then free to be taken again — by the job's retry, by picking it again, or by
 * the sweep that says what happened.
 */
export const DOWNLOAD_ABANDONED_MS = 30 * 60_000;

/** A file-less Picker row a download may take: waiting for one, or left behind by one that died. */
export function takeableDownload(now = Date.now()) {
  return {
    originalPath: "pending",
    OR: [{ status: "PENDING" as const }, { status: "PROCESSING" as const, updatedAt: { lt: new Date(now - DOWNLOAD_ABANDONED_MS) } }],
  };
}

/** What a member reads on a Picker item that never arrived: it has no file, so Re-process has nothing to work on. */
export const PICK_AGAIN = "Pick it again in Google Photos to fetch it.";
