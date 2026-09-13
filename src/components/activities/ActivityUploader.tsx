"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Uploader } from "@/components/photos/Uploader";

/**
 * Adding photos to an activity from the activity's own page.
 *
 * Until now an item reached an activity only by falling inside its time window, which is right for a camera and
 * wrong for everything else: a scan of a print from that walk, a photo a cousin sent afterwards, a clip whose file
 * lost its date on the way. Uploading here says plainly which activity these belong to, and the album keeps them
 * there even when their dates say otherwise.
 */
export function ActivityUploader({ activityId, maxClipSeconds, annotationActive }: { activityId: string; maxClipSeconds: number; annotationActive: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="activity-upload-open">
        Add photos to this activity
      </Button>
    );
  }
  return (
    <div className="rounded-theme border border-border bg-surface p-4 space-y-3" data-testid="activity-upload">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">These go on this activity and its trip, whatever date the files carry.</p>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); router.refresh(); }}>Done</Button>
      </div>
      <Uploader activityId={activityId} maxClipSeconds={maxClipSeconds} annotationActive={annotationActive} onDone={() => router.refresh()} />
    </div>
  );
}
