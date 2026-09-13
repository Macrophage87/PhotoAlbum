"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

/**
 * A link, there to be taken.
 *
 * Most sharing in a family is not a button on a social network: it is pasting the link into a message to three
 * cousins. So the link is shown in full, selectable, with one press to copy it — and where the browser will not
 * give the clipboard (an insecure origin, an old browser, a refused permission) the text is selected instead so
 * the usual copy still works.
 */
export function CopyLink({ url, label = "Copy link", note }: { url: string; label?: string; /** A line under the link, for what copying it means. */ note?: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Left selected: whatever this browser does for copying will now do it.
    }
  };

  return (
    <div className="space-y-1" data-testid="copy-link">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={field}
          readOnly
          value={url}
          aria-label="Share link"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 h-9 rounded-theme border border-border bg-surface-alt px-2 text-xs font-mono"
        />
        <Button type="button" size="sm" variant="secondary" onClick={copy} data-testid="copy-link-button">{copied ? "Copied" : label}</Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{copied ? "Link copied." : ""}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}
