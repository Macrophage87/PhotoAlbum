/** Queue names and payload types. Handlers live in ./handlers. */
export const QUEUES = {
  processPhoto: "process-photo",
  importTrack: "import-track",
  geotagPhotos: "geotag-photos",
  deletePhoto: "delete-photo",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type ProcessPhotoJob = { photoId: string; tripId?: string | null };
export type ImportTrackJob = {
  importKey: string;
  tripId: string;
  userId: string;
  sourceHint: "auto" | "gpx" | "fit" | "google";
  originalName: string;
};
export type GeotagPhotosJob = { tripId: string; trackIds?: string[] };
export type DeletePhotoJob = { storageKey: string };
