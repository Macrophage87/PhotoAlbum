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
export function CopyLink({ url, label = "Copy link", note, wrap = false }: { url: string; label?: string; /** A line under the link, for what copying it means. */ note?: string; /** Show the whole link over as many lines as it needs, with the button under it: for a narrow panel, where a one-line box shows only its start. */ wrap?: boolean }) {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      // Some browsers hand over the clipboard only to a page in front, or not at all. The link is selected either
      // way, so say what is left to do rather than looking like nothing happened at all.
      setState("selected");
    }
  };

  return (
    <div className="space-y-1" data-testid="copy-link">
      {wrap ? (
        <div className="space-y-2">
          <textarea
            ref={field}
            readOnly
            value={url}
            aria-label="Share link"
            rows={2}
            onFocus={(e) => e.currentTarget.select()}
            className="block w-full resize-none rounded-theme border border-border bg-surface-alt px-2 py-1.5 text-sm font-mono text-text break-all"
          />
          <Button type="button" size="sm" variant="secondary" onClick={copy} data-testid="copy-link-button">{state === "copied" ? "Copied" : label}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={field}
            readOnly
            value={url}
            aria-label="Share link"
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 h-9 rounded-theme border border-border bg-surface-alt px-2 text-xs font-mono"
          />
          <Button type="button" size="sm" variant="secondary" onClick={copy} data-testid="copy-link-button">{state === "copied" ? "Copied" : label}</Button>
        </div>
      )}
      <p role="status" aria-live="polite" className={state === "selected" ? "text-xs text-muted" : "sr-only"}>
        {state === "copied" ? "Link copied." : state === "selected" ? "Selected — press Ctrl+C (⌘C on a Mac) to copy." : ""}
      </p>
      {note && <p className={wrap ? "text-sm text-muted" : "text-xs text-muted"}>{note}</p>}
    </div>
  );
}
