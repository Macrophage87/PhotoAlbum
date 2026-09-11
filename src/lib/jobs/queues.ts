/** Queue names and payload types. Handlers live in ./handlers. */
export const QUEUES = {
  processPhoto: "process-photo",
  importTrack: "import-track",
  geotagPhotos: "geotag-photos",
  deletePhoto: "delete-photo",
  checkExternalVideos: "check-external-videos",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** `renditions` only makes thumbnails (posters of external videos); `full` also reads EXIF, resolves dates and assigns a trip. */
export type ProcessPhotoJob = { photoId: string; tripId?: string | null; mode?: "full" | "renditions" };
export type CheckExternalVideosJob = Record<string, never>;
export type ImportTrackJob = {
  importKey: string;
  tripId: string;
  userId: string;
  sourceHint: "auto" | "gpx" | "fit" | "google";
  originalName: string;
};
export type GeotagPhotosJob = { tripId: string; trackIds?: string[] };
export type DeletePhotoJob = { storageKey: string };
