import { importTrackFile } from "@/lib/tracks/import";
import { forgetTrackFiles } from "@/lib/tracks/files";
import { enqueue } from "../boss";
import { QUEUES, type ImportTrackJob } from "../queues";

/**
 * The uploaded file is kept only while a track needs it. A Google export is read for the trip's days and then
 * deleted: it is years of somebody's whereabouts, and the tracks hold all that was wanted from it. A GPX or FIT file
 * that failed, or gave no tracks, goes too; one that made tracks stays with them (see forgetTrackFiles).
 */
export async function importTrack(job: ImportTrackJob): Promise<unknown> {
  let summary: Awaited<ReturnType<typeof importTrackFile>>;
  try {
    summary = await importTrackFile(job);
  } catch (err) {
    await forgetTrackFiles([job.importKey]);
    throw err;
  }
  if (summary.kind === "google" || !summary.tracks.length) await forgetTrackFiles([job.importKey]);
  if (summary.tracks.length) {
    await enqueue(QUEUES.geotagPhotos, { tripId: job.tripId, trackIds: summary.tracks.map((t) => t.trackId) });
  }
  return summary;
}
