import { failureForStatus, STALL_MS, type UploadFailure } from "./upload-retry";

/** Thrown out of an attempt so the queue can tell a dropped connection from a refusal. */
export class AttemptError extends Error {
  constructor(readonly failure: UploadFailure) {
    super(failure.message);
  }
}

/**
 * One go at sending one file.
 *
 * Every way this can end has to end it. An XHR that is abandoned — which is what a phone does to whatever is in
 * flight when its screen locks, when the album goes to the background, or when wifi hands over to the mobile
 * network — fires neither load nor error, so without `onabort` the promise would never settle, the slot it was
 * using would never come back, and after three of them the whole batch would stop dead with no error anywhere.
 * That is what made a hundred photographs look as though nothing had happened.
 */
/** What the album did with a file it already had, when it was sent to a particular trip, activity or collection. */
export type FiledAnswer = { trip: boolean; activity: boolean; collection: boolean; movedFrom: string | null; notYours: boolean };
/** `status` comes with a file the album already had: how far along that one is. */
export type UploadAnswer = { photoId: string; duplicate?: boolean; status?: string; filed?: FiledAnswer; owner?: string | null };
export type UploadTarget = { tripId?: string; activityId?: string; collectionId?: string };

/**
 * What a tile shows once its file has arrived. A new one is being processed. A file the album already had is ready
 * only when that one is: matched to a copy still being processed, or one that failed, it is watched like any other,
 * so its tile ends up saying what actually became of it.
 */
export function statusAfterUpload(answer: Pick<UploadAnswer, "duplicate" | "status">): "processing" | "ready" {
  return answer.duplicate && (answer.status === undefined || answer.status === "READY") ? "ready" : "processing";
}

/** `attempt` is which go this is at the same file, so the album can tell a retry from the same file sent again. */
export function attemptUpload(file: File, target: UploadTarget, optOut: boolean, onProgress: (p: number) => void, register: (abort: () => void) => void, attempt = 1): Promise<UploadAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn();
    };
    // Bytes stop moving and never start again on a connection that has gone without saying so; nothing else notices.
    let watchdog = setTimeout(() => finish(() => { xhr.abort(); reject(new AttemptError({ kind: "stalled", message: "Nothing was getting through." })); }), STALL_MS);
    const touch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish(() => { xhr.abort(); reject(new AttemptError({ kind: "stalled", message: "Nothing was getting through." })); }), STALL_MS);
    };

    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-last-modified", String(file.lastModified));
    if (target.tripId) xhr.setRequestHeader("x-trip-id", target.tripId);
    // An activity also settles the trip, whatever the file's own date says.
    if (target.activityId) xhr.setRequestHeader("x-activity-id", target.activityId);
    if (target.collectionId) xhr.setRequestHeader("x-collection-id", target.collectionId);
    if (optOut) xhr.setRequestHeader("x-annotation-opt-out", "1");
    if (attempt > 1) xhr.setRequestHeader("x-upload-attempt", String(attempt));
    xhr.upload.onprogress = (e) => {
      touch();
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      finish(() => {
        let body: Partial<UploadAnswer> & { error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // An answer that is not JSON is usually something in front of the album, not the album itself.
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.photoId) return resolve({ photoId: body.photoId, duplicate: body.duplicate, status: body.status, filed: body.filed, owner: body.owner });
        reject(new AttemptError(failureForStatus(xhr.status, body.error)));
      });
    xhr.onerror = () => finish(() => reject(new AttemptError({ kind: "network", message: "The connection dropped." })));
    xhr.onabort = () => finish(() => reject(new AttemptError({ kind: "network", message: "The upload was interrupted." })));
    xhr.ontimeout = () => finish(() => reject(new AttemptError({ kind: "network", message: "The album took too long to answer." })));
    register(() => xhr.abort());
    xhr.send(file);
  });
}

