"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Uploader } from "@/components/photos/Uploader";

/**
 * Adding photos from the page of the thing they belong to — an activity, a collection — rather than from the upload
 * page with that thing picked.
 *
 * A button until it is wanted, so the page stays about its photographs. Pressed, it asks the one question that
 * matters: are these new photos on this device, or ones already in the album? New ones get the ordinary uploader,
 * sending everything to `target`; ones already in the album go to the picker, with the whole album to search. Where
 * there is a time to go by, a third choice takes everything from then in one press.
 */
export function InlineUploader({ target, openLabel, note, testId, maxClipSeconds, annotationActive, pickHref, takeAll }: {
  target: { activityId?: string; collectionId?: string };
  /** What the closed button says: "Add photos to this activity". */
  openLabel: string;
  /** One line above the uploader saying where new ones go. */
  note: string;
  /** `${testId}-open` for the button, `testId` for the open panel. */
  testId: string;
  maxClipSeconds: number;
  annotationActive: boolean;
  /** The picker for photographs already in the album. */
  pickHref?: string;
  /** Everything from the time it happened, in one press: see `TakeWindow`. */
  takeAll?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(!pickHref && !takeAll);
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
        <p className="text-sm font-medium">{openLabel}</p>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); router.refresh(); }}>Done</Button>
      </div>
      {(pickHref || takeAll) && (
        <div className="flex flex-wrap items-start gap-2" data-testid={`${testId}-choices`}>
          <Button type="button" size="sm" variant={uploading ? "primary" : "secondary"} onClick={() => setUploading(true)} data-testid={`${testId}-device`}>
            New photos from this device
          </Button>
          {pickHref && (
            <Link href={pickHref} className="inline-flex items-center h-9 px-3 rounded-theme border border-border bg-surface text-sm hover:bg-surface-alt" data-testid={`${testId}-pick`}>
              Choose from photos already in the album
            </Link>
          )}
          {takeAll}
        </div>
      )}
      {uploading && (
        <>
          <p className="text-sm text-muted">{note}</p>
          <Uploader activityId={target.activityId} collectionId={target.collectionId} maxClipSeconds={maxClipSeconds} annotationActive={annotationActive} onDone={() => router.refresh()} />
        </>
      )}
    </div>
  );
}
