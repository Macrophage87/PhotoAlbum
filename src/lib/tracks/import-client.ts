import { statusRetryMs } from "@/lib/media/upload-retry";

/**
 * The track importer's side of an import, in the browser: sending the file, then asking how the job went. Kept out
 * of the component so every way either can end is tested.
 */

export type ImportSummary = { kind: string; format?: string; tracks: { trackId: string; activityId: string | null; name: string; pointCount: number; distanceM: number; type: string | null }[]; skipped: string[]; pointsRead: number };

/**
 * Send one file. Every way this can end has to end it: a phone that locks its screen mid-file abandons the request
 * with neither load nor error, and without `onabort` the item would say "Uploading" for ever.
 */
export function sendTrackFile(file: File, tripId: string, hint: string, replaceGoogle: boolean, onProgress: (p: number) => void): Promise<{ jobId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/tracks/import");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-trip-id", tripId);
    xhr.setRequestHeader("x-source-hint", hint);
    if (replaceGoogle) xhr.setRequestHeader("x-replace-google", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status < 300) resolve(body);
        else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("The connection dropped. Choose the file again to retry."));
    xhr.onabort = () => reject(new Error("The upload was interrupted. Choose the file again to retry."));
    xhr.ontimeout = () => reject(new Error("The album took too long to answer. Choose the file again to retry."));
    xhr.send(file);
  });
}

/** Longer than the job itself may run (it is stopped after an hour), so the page always hears how it ended. */
export const IMPORT_WAIT_MS = 65 * 60_000;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask how the import went until it is done. A missed answer is not a failed import: the file is on the server and
 * being read whether or not this page is watching, and a phone that locks its screen misses an answer or two. So a
 * question that goes unanswered is asked again, a little later each time; only the server's own answer ends it.
 * `onTrouble` says whether the last question went unanswered.
 */
export async function waitForImport(jobId: string, opts: { sleep?: (ms: number) => Promise<void>; now?: () => number; onTrouble?: (trouble: boolean) => void } = {}): Promise<ImportSummary> {
  const sleep = opts.sleep ?? wait;
  const now = opts.now ?? Date.now;
  const until = now() + IMPORT_WAIT_MS;
  let misses = 0;
  for (let asked = 0; now() < until; asked++) {
    await sleep(misses ? statusRetryMs(misses) : asked < 10 ? 1000 : 3000);
    const res = await fetch(`/api/tracks/import/${jobId}`).catch(() => null);
    if (res?.status === 401) throw new Error("You were signed out. Sign in again; the import carries on without this page.");
    if (!res || res.status === 408 || res.status === 429 || res.status >= 500) {
      misses += 1;
      opts.onTrouble?.(true);
      continue;
    }
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    // An answer that is not JSON is something in front of the album (a captive portal, a proxy's error page).
    const j = (await res.json().catch(() => null)) as { state: string; summary: ImportSummary | null; error: string | null } | null;
    if (!j) {
      misses += 1;
      opts.onTrouble?.(true);
      continue;
    }
    if (misses) opts.onTrouble?.(false);
    misses = 0;
    if (j.state === "completed" && j.summary) return j.summary;
    if (j.state === "failed" || j.state === "cancelled") throw new Error(j.error ?? "Import failed");
  }
  throw new Error("Timed out waiting for the import");
}
