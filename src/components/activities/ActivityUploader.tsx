import type { ReactNode } from "react";
import { InlineUploader } from "@/components/photos/InlineUploader";
import type { UploadByteLimits } from "@/lib/media/limits";

/**
 * Adding photos to an activity from the activity's own page: new ones from this device, ones already in the album,
 * or everything taken while it was happening.
 *
 * Until now an item reached an activity only by falling inside its time window, which is right for a camera and
 * wrong for everything else: a scan of a print from that walk, a photo a cousin sent afterwards, a clip whose file
 * lost its date on the way. Adding them here says plainly which activity these belong to, and the album keeps them
 * there even when their dates say otherwise.
 */
export function ActivityUploader({ activityId, maxClipSeconds, maxBytes, annotationActive, pickHref, takeAll }: { activityId: string; maxClipSeconds: number; maxBytes: UploadByteLimits; annotationActive: boolean; pickHref: string; takeAll?: ReactNode }) {
  return (
    <InlineUploader
      target={{ activityId }}
      openLabel="Add photos to this activity"
      note="These go on this activity and its trip, whatever date the files carry."
      testId="activity-upload"
      maxClipSeconds={maxClipSeconds}
      maxBytes={maxBytes}
      annotationActive={annotationActive}
      pickHref={pickHref}
      takeAll={takeAll}
    />
  );
}
