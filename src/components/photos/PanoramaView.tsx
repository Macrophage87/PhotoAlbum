"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A panorama shown as a panorama: filling the height of whatever box it is given and panned sideways, rather than
 * shrunk until the whole sweep fits and none of it can be seen.
 *
 * It pans by scrolling, so a phone's own touch scrolling, a trackpad and the keyboard all work without any help;
 * a mouse gets drag-to-pan on top of that, which is what people try first. A full 360 is drawn twice end to end
 * and the scroll position wrapped, so panning runs on round the horizon instead of stopping at a seam.
 */
export function PanoramaView({ src, alt, wrap = false, axis = "horizontal", className, children }: {
  src: string;
  alt: string;
  /** A full 360: the two edges meet, so panning can run on for ever. */
  wrap?: boolean;
  axis?: "horizontal" | "vertical";
  className?: string;
  children?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const from = useRef({ pointer: 0, scroll: 0 });
  const horizontal = axis === "horizontal";

  // Start in the middle: a panorama has as much to see one way as the other, and a 360 needs room on both sides.
  const centre = useCallback(() => {
    const el = box.current;
    if (!el) return;
    if (horizontal) el.scrollLeft = wrap ? el.scrollWidth / 4 : (el.scrollWidth - el.clientWidth) / 2;
    else el.scrollTop = wrap ? el.scrollHeight / 4 : (el.scrollHeight - el.clientHeight) / 2;
  }, [horizontal, wrap]);

  const onScroll = () => {
    const el = box.current;
    if (!el || !wrap) return;
    // Two copies end to end: stepping back by one copy's length whenever the scroll passes it keeps the picture
    // where it appears to be while leaving somewhere to carry on to.
    const span = (horizontal ? el.scrollWidth : el.scrollHeight) / 2;
    const at = horizontal ? el.scrollLeft : el.scrollTop;
    const wrapped = at >= span * 1.5 ? at - span : at <= span * 0.5 ? at + span : null;
    if (wrapped === null) return;
    if (horizontal) el.scrollLeft = wrapped;
    else el.scrollTop = wrapped;
  };

  return (
    // The overlay sits outside the scroller, so a hint stays put instead of scrolling away with the picture.
    <div className={`relative ${className ?? ""}`}>
      <div
        ref={box}
        onScroll={onScroll}
        data-testid="panorama-view"
        tabIndex={0}
        aria-label={`${alt} — a panorama; drag or scroll to look around`}
        className={`h-full w-full ${horizontal ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto overflow-x-hidden"} overscroll-contain select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={(e) => {
          if (e.pointerType === "touch") return; // the browser's own scrolling is better than anything done by hand
          e.preventDefault();
          e.stopPropagation();
          const el = box.current;
          if (!el) return;
          el.setPointerCapture(e.pointerId);
          from.current = { pointer: horizontal ? e.clientX : e.clientY, scroll: horizontal ? el.scrollLeft : el.scrollTop };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const el = box.current;
          if (!el) return;
          const moved = (horizontal ? e.clientX : e.clientY) - from.current.pointer;
          if (horizontal) el.scrollLeft = from.current.scroll - moved;
          else el.scrollTop = from.current.scroll - moved;
        }}
        onPointerUp={(e) => { box.current?.releasePointerCapture(e.pointerId); setDragging(false); }}
        onPointerCancel={() => setDragging(false)}
        // A drag that ends over the picture must not also count as a click on it, which in a lightbox means closing it.
        onClickCapture={(e) => { if (dragging) { e.preventDefault(); e.stopPropagation(); } }}
      >
        <div className={horizontal ? "flex h-full w-max" : "w-full"}>
          <PanoImage src={src} alt={alt} horizontal={horizontal} onReady={centre} />
          {wrap && <PanoImage src={src} alt="" horizontal={horizontal} aria-hidden />}
        </div>
      </div>
      {children}
    </div>
  );
}

function PanoImage({ src, alt, horizontal, onReady, ...rest }: { src: string; alt: string; horizontal: boolean; onReady?: () => void } & React.ImgHTMLAttributes<HTMLImageElement>) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} draggable={false} onLoad={onReady} className={horizontal ? "h-full w-auto max-w-none" : "w-full h-auto max-h-none"} {...rest} />;
}

/** The one-line invitation shown over a panorama, so nobody stares at a slice wondering where the rest went. */
export function PanoramaHint({ label }: { label: string }) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSeen(true), 4000);
    return () => clearTimeout(t);
  }, []);
  if (seen) return null;
  return (
    <span className="pointer-events-none absolute left-1/2 bottom-2 -translate-x-1/2 rounded-full bg-black/60 text-white text-xs px-3 py-1 whitespace-nowrap">
      {label} · drag to look around
    </span>
  );
}
