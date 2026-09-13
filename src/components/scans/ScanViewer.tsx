"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A 3D scan, turned and looked at.
 *
 * A phone scanner gives back one of two quite different things. A mesh — Scaniverse's .glb, or Apple's .usdz — is a
 * shape with a skin on it, which a browser can draw and a phone can stand up in the room in front of you. A
 * gaussian splat — .ply or .spz — is a cloud of a million coloured blobs; nothing standard draws one, so the album
 * keeps the file exactly as it came and hands it back to the app that made it rather than pretending otherwise.
 *
 * The first time a member opens a mesh, the browser sends back a still of what it drew, which is where the tile in
 * the grids comes from: the server has no way to draw a scan itself.
 */

type ModelViewerElement = HTMLElement & { toBlob?: (opts?: { mimeType?: string; qualityArgument?: number }) => Promise<Blob> };

export function ScanViewer({ photoId, modelUrl, format, posterUrl, canPoster, alt, className }: {
  photoId: string;
  modelUrl: string;
  format: string | null;
  /** The still already taken, when one has been. */
  posterUrl: string | null;
  /** Whether this viewer may send a still back: members who can change the item, and only when there is none. */
  canPoster: boolean;
  alt: string;
  className?: string;
}) {
  const ref = useRef<ModelViewerElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const viewable = format === "GLB";

  // The web component brings its own renderer, so it is only fetched when there is actually a mesh to draw.
  useEffect(() => {
    if (!viewable) return;
    let live = true;
    import("@google/model-viewer")
      .then(() => { if (live) setReady(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [viewable]);

  // One still, taken once the scan is actually on screen, so the grids have something to show.
  useEffect(() => {
    if (!ready || !canPoster || posterUrl) return;
    const el = ref.current;
    if (!el) return;
    let live = true;
    const send = async () => {
      if (!live || !el.toBlob) return;
      try {
        const blob = await el.toBlob({ mimeType: "image/jpeg", qualityArgument: 0.85 });
        await fetch(`/api/photos/${photoId}/poster`, { method: "POST", body: blob, credentials: "same-origin" });
      } catch {
        // A tile is a nicety; never let taking one break looking at the scan.
      }
    };
    el.addEventListener("load", send, { once: true });
    return () => { live = false; el.removeEventListener("load", send); };
  }, [ready, canPoster, posterUrl, photoId]);

  if (!viewable) {
    return (
      <div className={`rounded-theme border border-border bg-surface-alt p-4 text-sm space-y-2 ${className ?? ""}`} data-testid="scan-keepsafe">
        <p className="font-medium">A {format === "USDZ" ? "3D scan for Apple devices" : "gaussian splat"} is kept here whole.</p>
        <p className="text-muted">
          {format === "USDZ"
            ? "An iPhone, iPad or Mac opens it by itself, and will stand it up in the room in front of you."
            : "A splat is a cloud of coloured points rather than a shape with a skin; it opens in Scaniverse, or in any splat viewer. Export the same scan as GLB and the album will show it here."}
        </p>
        <a href={modelUrl} className="text-primary underline underline-offset-2" download>
          Download the scan
        </a>
      </div>
    );
  }

  if (failed) {
    return (
      <p className={`rounded-theme border border-border bg-surface-alt p-4 text-sm ${className ?? ""}`}>
        The 3D viewer could not be loaded. <a href={modelUrl} className="text-primary underline underline-offset-2" download>Download the scan</a> instead.
      </p>
    );
  }

  return (
    <div className={`relative rounded-theme overflow-hidden border border-border bg-surface-alt ${className ?? ""}`} data-testid="scan-viewer">
      {ready ? (
        // @ts-expect-error — a web component, registered by the import above.
        <model-viewer
          ref={ref}
          src={modelUrl}
          alt={alt}
          poster={posterUrl ?? undefined}
          camera-controls
          touch-action="pan-y"
          ar
          ar-modes="webxr scene-viewer quick-look"
          shadow-intensity="1"
          style={{ width: "100%", height: "100%", minHeight: "20rem", backgroundColor: "transparent" }}
        />
      ) : (
        <div className="w-full h-full min-h-80 animate-pulse" aria-busy="true" />
      )}
      <span className="absolute top-2 left-2 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">3D scan · drag to turn</span>
    </div>
  );
}
