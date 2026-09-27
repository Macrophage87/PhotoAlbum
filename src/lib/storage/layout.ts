/** The names the album itself gives what it keeps under the storage root. Nothing else there is any sweep's. */

/** A photo's own folder: photos/<its row's cuid>. */
export const PHOTO_FOLDER = /^c[a-z0-9]{24}$/;
/** What the track import route stores: imports/<uuid>.<ext>. */
export const IMPORT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/;
/**
 * An uploaded track file no job has read in this long was left by an import that died with its worker: the job is
 * queued with no retry and expires after an hour, and only the job deletes its file.
 */
export const IMPORT_ABANDONED_MS = 6 * 3600_000;
