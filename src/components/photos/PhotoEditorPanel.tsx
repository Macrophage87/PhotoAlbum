"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { PhotoEditor } from "./PhotoEditor";
import type { PhotoEdits } from "@/lib/images/edits";

/** The way in to the darkroom: a button until it is wanted, so the page is not a pile of sliders. */
export function PhotoEditorPanel({ photoId, src, initial, edited }: { photoId: string; src: string; initial: PhotoEdits | null; edited: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {edited ? "Edit again" : "Crop and colour"}
      </Button>
    );
  }
  return (
    <div className="rounded-theme border border-border p-3">
      <PhotoEditor photoId={photoId} src={src} initial={initial} onDone={() => setOpen(false)} />
    </div>
  );
}
