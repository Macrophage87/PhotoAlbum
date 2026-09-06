import { importTrackFile } from "@/lib/tracks/import";
import { enqueue } from "../boss";
import { QUEUES, type ImportTrackJob } from "../queues";

export async function importTrack(job: ImportTrackJob): Promise<unknown> {
  const summary = await importTrackFile(job);
  if (summary.tracks.length) {
    await enqueue(QUEUES.geotagPhotos, { tripId: job.tripId, trackIds: summary.tracks.map((t) => t.trackId) });
  }
  return summary;
}
