import { kindForMime } from "./mime";

/** The largest file of each kind the album takes, handed to the uploader as well so it can refuse before sending. */
export type UploadByteLimits = { photo: number; video: number; scan: number };

/** A scan is held to its own limit: a gaussian splat runs to hundreds of megabytes, far past any photograph. */
export function maxUploadBytes(mime: string, limits: UploadByteLimits): number {
  const kind = kindForMime(mime);
  return kind === "VIDEO" ? limits.video : kind === "SCAN" ? limits.scan : limits.photo;
}

/** An empty file is nothing to keep: a copy that failed on the phone, or a placeholder a cloud drive never filled in. */
export const EMPTY_FILE_MESSAGE = "This file is empty (0 bytes), so there is nothing to upload. Check that it opens on your device, then try again.";

/** Said before a byte is sent, in the same terms the server would use afterwards. */
export function tooBigMessage(bytes: number, limit: number): string {
  return `This file is ${Math.ceil(bytes / 1048576)} MB; the album takes files of this kind up to ${Math.round(limit / 1048576)} MB.`;
}
