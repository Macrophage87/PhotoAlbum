"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Uploader } from "@/components/photos/Uploader";

/**
 * Uploading from the page of the thing the photographs belong to — an activity, a collection — rather than from the
 * upload page with that thing picked. A button until it is wanted, so the page stays about its photographs; then the
 * ordinary uploader, sending everything to `target`, and the page refreshes as they arrive.
 */
export function InlineUploader({ target, openLabel, note, testId, maxClipSeconds, annotationActive }: {
  target: { activityId?: string; collectionId?: string };
  /** What the closed button says: "Add photos to this activity". */
  openLabel: string;
  /** One line above the uploader saying where these go. */
  note: string;
  /** `${testId}-open` for the button, `testId` for the open panel. */
  testId: string;
  maxClipSeconds: number;
  annotationActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid={`${testId}-open`}>
        {openLabel}
      </Button>
    );
  }
  return (
    <div className="w-full rounded-theme border border-border bg-surface p-4 space-y-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">{note}</p>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); router.refresh(); }}>Done</Button>
      </div>
      <Uploader activityId={target.activityId} collectionId={target.collectionId} maxClipSeconds={maxClipSeconds} annotationActive={annotationActive} onDone={() => router.refresh()} />
    </div>
  );
}
