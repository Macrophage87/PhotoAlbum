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
  matchPhoto: "match-photo",
  flagNewAdults: "flag-new-adults",
  takeoutImport: "takeout-import",
  detectAnimals: "detect-animals",
  animalSweep: "animal-sweep",
  matchAnimals: "match-animals",
  googlePickerImport: "google-picker-import",
  purgeVisits: "purge-visits",
  purgeMagicLinks: "purge-magic-links",
  rejudgeText: "rejudge-text",
  sweepStrandedUploads: "sweep-stranded-uploads",
  reconcilePhotos: "reconcile-photos",
  sweepOrphanFiles: "sweep-orphan-files",
  revokeGoogle: "revoke-google",
  finishRemovals: "finish-removals",
  visitorCopy: "visitor-copy",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** `renditions` only makes thumbnails (posters of external videos); `full` also reads EXIF, resolves dates and assigns a trip. */
export type ProcessPhotoJob = { photoId: string; tripId?: string | null; mode?: "full" | "renditions" };
export type TranscodeVideoJob = { photoId: string; tripId?: string | null };
/** The picture as it was at `imageVersion`: a job for an older one finds nothing to do. */
export type VisitorCopyJob = { photoId: string; imageVersion: number };
export type CheckExternalVideosJob = Record<string, never>;
export type ImportTrackJob = {
  importKey: string;
  tripId: string;
  userId: string;
  sourceHint: "auto" | "gpx" | "fit" | "google";
  originalName: string;
  /** Google exports: replace the importing member's earlier traces for the same days rather than keep both. */
  replaceGoogle?: boolean;
};
export type GeotagPhotosJob = { tripId: string; trackIds?: string[] };
export type DeletePhotoJob = { storageKey: string };
/** `replace`: a member asked for a new description over the family's own edited one, and confirmed it. */
export type AnnotatePhotoJob = { photoId: string; replace?: boolean };
export type AnnotationBackfillJob = { batchId: string };
export type EmbedPhotoJob = { photoId: string; textOnly?: boolean };
export type DetectFacesJob = { photoId: string };
export type MatchPhotoJob = { photoId: string };
export type TakeoutImportJob = { importId: string };
export type DetectAnimalsJob = { photoId: string };
export type MatchAnimalsJob = { photoId: string };
/** Rows were created by the action; the job downloads each `items[photoId]` (a Picker media item) into its row. */
export type GooglePickerImportJob = { userId: string; sessionId: string; photoIds: string[]; items: Record<string, unknown> };
