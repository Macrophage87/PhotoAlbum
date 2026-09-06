"use client";

import { useEffect, useRef } from "react";
import uPlot, { type Options, type AlignedData } from "uplot";
import "uplot/dist/uPlot.min.css";

/** Thin uPlot wrapper: sizes to its container and reports the hovered sample index. */
export function UPlotChart({ data, options, height = 160, onCursor, className = "" }: { data: AlignedData; options: Omit<Options, "width" | "height">; height?: number; onCursor?: (idx: number | null) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const onCursorRef = useRef(onCursor);
  useEffect(() => {
    onCursorRef.current = onCursor;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opts: Options = {
      ...options,
      width: el.clientWidth || 600,
      height,
      hooks: {
        ...options.hooks,
        setCursor: [
          ...(options.hooks?.setCursor ?? []),
          (u) => {
            const idx = u.cursor.idx;
            onCursorRef.current?.(idx === null || idx === undefined ? null : idx);
          },
        ],
      },
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Recreate when the data set changes; options are treated as static per data set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, height]);

  return <div ref={ref} className={className} />;
}
