import { InlineUploader } from "@/components/photos/InlineUploader";

/**
 * Adding photos to an activity from the activity's own page.
 *
 * Until now an item reached an activity only by falling inside its time window, which is right for a camera and
 * wrong for everything else: a scan of a print from that walk, a photo a cousin sent afterwards, a clip whose file
 * lost its date on the way. Uploading here says plainly which activity these belong to, and the album keeps them
 * there even when their dates say otherwise.
 */
export function ActivityUploader({ activityId, maxClipSeconds, annotationActive }: { activityId: string; maxClipSeconds: number; annotationActive: boolean }) {
  return (
    <InlineUploader
      target={{ activityId }}
      openLabel="Add photos to this activity"
      note="These go on this activity and its trip, whatever date the files carry."
      testId="activity-upload"
      maxClipSeconds={maxClipSeconds}
      annotationActive={annotationActive}
    />
  );
}
