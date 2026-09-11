"use client";

import dynamic from "next/dynamic";

export const GraphViewDynamic = dynamic(() => import("./GraphView").then((m) => m.GraphView), { ssr: false, loading: () => <div className="h-[70vh] rounded-theme border border-border bg-surface-alt animate-pulse" /> });
