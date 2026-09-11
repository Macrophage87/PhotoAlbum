/** Queue names and payload types. Handlers live in ./handlers. */
export const QUEUES = {
  processPhoto: "process-photo",
  importTrack: "import-track",
  geotagPhotos: "geotag-photos",
  deletePhoto: "delete-photo",
  checkExternalVideos: "check-external-videos",
  transcodeVideo: "transcode-video",
  annotatePhoto: "annotate-photo",
  annotationSweep: "annotation-sweep",
  annotationBackfill: "annotation-backfill",
  annotationBatchPoll: "annotation-batch-poll",
  purgeAnnotationRaw: "purge-annotation-raw",
  embedPhoto: "embed-photo",
  embedSweep: "embed-sweep",
  detectFaces: "detect-faces",
  faceSweep: "face-sweep",
  purgeUnnamedFaces: "purge-unnamed-faces",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** `renditions` only makes thumbnails (posters of external videos); `full` also reads EXIF, resolves dates and assigns a trip. */
export type ProcessPhotoJob = { photoId: string; tripId?: string | null; mode?: "full" | "renditions" };
export type TranscodeVideoJob = { photoId: string; tripId?: string | null };
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
export type AnnotatePhotoJob = { photoId: string };
export type AnnotationBackfillJob = { batchId: string };
export type EmbedPhotoJob = { photoId: string; textOnly?: boolean };
export type DetectFacesJob = { photoId: string };
