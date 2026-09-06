import type { GeotagPhotosJob } from "../queues";

/** Phase 5 fills this in: position GPS-less photos from tracks. */
export async function geotagPhotos(job: GeotagPhotosJob): Promise<void> {
  console.log("[geotag-photos] not implemented yet", job.tripId);
}
