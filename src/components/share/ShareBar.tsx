"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { ShareButtons } from "@/components/trips/ShareButtons";
import { CopyLink } from "./CopyLink";

/** Room kept between the panel and the screen's edges. */
const EDGE = 16;
/** The panel's width where the screen allows it. */
const WIDTH = 384;

/**
 * The share control in a header: a button that opens the link itself, ready to copy, with Facebook beside it.
 *
 * Copying beats posting for most of what a family does — the link goes into a message, an email, a group chat —
 * and wherever it is pasted, the preview carries the title and the cover photo with it.
 *
 * The panel is placed against the button but kept inside the screen: the button sits on the right of a wide header
 * and on the left of a phone's, and a panel hung from one fixed side of it ran off the other edge.
 */
export function ShareBar({ url, what }: { url: string; /** "trip", "activity" or "collection", for the line under the link. */ what: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth;
    const width = Math.min(WIDTH, vw - 2 * EDGE);
    const left = Math.min(Math.max(r.right - width, EDGE), vw - width - EDGE);
    setAt({ top: r.bottom + 8, left, width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, place]);

  return (
    <div ref={anchor}>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="share-open">
        Share
      </Button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={`Share this ${what}`}
          style={at ? { top: at.top, left: at.left, width: at.width } : { visibility: "hidden" }}
          className="fixed z-50 rounded-theme border border-border bg-surface text-text shadow-lg p-4 space-y-3"
          data-testid="share-panel"
        >
          <CopyLink url={url} wrap note={`Anyone with this link can open the ${what}. Pasted into a message or a post, it brings the title and cover photo with it.`} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ShareButtons url={url} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}
