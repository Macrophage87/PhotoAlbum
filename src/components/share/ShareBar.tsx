"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { ShareButtons } from "@/components/trips/ShareButtons";
import { CopyLink } from "./CopyLink";

/**
 * The share control in a header: a button that opens the link itself, ready to copy, with Facebook beside it.
 *
 * Copying beats posting for most of what a family does — the link goes into a message, an email, a group chat —
 * and wherever it is pasted, the preview carries the title and the cover photo with it.
 */
export function ShareBar({ url, what }: { url: string; /** "trip" or "collection", for the line under the link. */ what: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="share-open">
        Share
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[85vw] rounded-theme border border-border bg-surface shadow-lg p-3 space-y-3">
          <CopyLink url={url} note={`Anyone with this link can open the ${what}. Pasted into a message or a post, it brings the title and cover photo with it.`} />
          <div className="flex items-center justify-between gap-2">
            <ShareButtons url={url} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}
