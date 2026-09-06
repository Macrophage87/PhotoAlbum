"use client";

import dynamic from "next/dynamic";

/** MapLibre touches `window`, so the real component only loads in the browser. */
export const MapViewDynamic = dynamic(() => import("./MapView").then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-surface-alt animate-pulse rounded-theme" />,
});
