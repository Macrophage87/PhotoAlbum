"use client";

import { useEffect, useRef, useState } from "react";
import { MIN_DRAWN } from "@/lib/images/poster";

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

type ModelViewerElement = HTMLElement & {
  toBlob?: (opts?: { mimeType?: string; qualityArgument?: number }) => Promise<Blob>;
  /** False until the scan is actually drawn on screen. See the still-taking below: it decides what a capture reads. */
  modelIsVisible?: boolean;
  updateComplete?: Promise<unknown>;
};

/** Two frames, so a capture reads one the browser has finished drawing rather than one it is part-way through. */
const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * How much of a still was drawn into at all. A capture taken at the wrong moment is empty, and an empty picture
 * saved as a tile is one the album would never think to take again, so it is measured before it is sent.
 */
async function drawnFraction(blob: Blob): Promise<number> {
  try {
    const bitmap = await createImageBitmap(blob);
    // A small copy answers the question just as well and costs a phone nothing.
    const w = Math.min(bitmap.width, 160);
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 1;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    bitmap.close?.();
    let drawn = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8) drawn += 1;
    return drawn / (w * h);
  } catch {
    // A browser that will not measure is not a reason to refuse a still; the server checks it too.
    return 1;
  }
}

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

  /**
   * One still, taken once the scan is actually drawn, so the grids have something to show.
   *
   * The moment matters more than it looks. The viewer finishes loading the file a little before it puts the first
   * frame of it on screen, and a capture taken in between does not read the drawing the member can see: it reads a
   * canvas nothing has painted into, and comes back as a rectangle of nothing — which a phone then writes out as
   * plain white. So the wait is for the scan to be *visible*, not merely loaded, and the still is measured before
   * it is sent and taken again if the frame was empty. It is kept as a PNG, which carries its own transparency, so
   * that no browser has to decide what colour the empty parts of the picture are.
   */
  useEffect(() => {
    if (!ready || !canPoster || posterUrl) return;
    const el = ref.current;
    if (!el) return;
    let live = true;
    let started = false; // The scan can come and go from view; one round of this is enough.
    /** A few goes, a frame apart: on a slow phone the first drawn frame can be a moment behind the word for it. */
    const ATTEMPTS = 5;

    const send = async () => {
      if (!el.toBlob) return;
      for (let attempt = 0; attempt < ATTEMPTS && live; attempt += 1) {
        try {
          await el.updateComplete;
          await twoFrames();
          if (!live) return;
          const blob = await el.toBlob({ mimeType: "image/png" });
          if (!live) return;
          if ((await drawnFraction(blob)) < MIN_DRAWN) continue;
          await fetch(`/api/photos/${photoId}/poster`, { method: "POST", body: blob, credentials: "same-origin" });
          return;
        } catch {
          // A tile is a nicety; never let taking one break looking at the scan.
          return;
        }
      }
    };

    const begin = () => {
      if (started || !el.modelIsVisible) return;
      started = true;
      el.removeEventListener("model-visibility", begin);
      void send();
    };
    el.addEventListener("model-visibility", begin);
    begin();
    return () => { live = false; el.removeEventListener("model-visibility", begin); };
  }, [ready, canPoster, posterUrl, photoId]);

  if (!viewable) {
    return (
      <div className={`rounded-theme border border-border bg-surface-alt p-4 text-sm space-y-2 ${className ?? ""}`} data-testid="scan-keepsafe">
        <p className="font-medium">A {format === "USDZ" ? "3D scan for Apple devices" : "gaussian splat"} is kept here whole.</p>
        <p className="text-muted">
          {format === "USDZ"
            ? "An iPhone, iPad or Mac opens it by itself, and will stand it up in the room in front of you."
            : "A splat is a cloud of colored points rather than a shape with a skin; it opens in Scaniverse, or in any splat viewer. Export the same scan as GLB and the album will show it here."}
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
