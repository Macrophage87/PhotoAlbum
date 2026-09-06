"use client";

import { useEffect, useMemo, useState } from "react";
import type { AlignedData } from "uplot";
import type { ActivityType } from "@/generated/prisma/enums";
import type { ColumnarPoints } from "@/lib/tracks/types";
import { ACTIVITY_COLOR } from "@/lib/activities/types";
import { UPlotChart } from "./UPlotChart";

type PointsPayload = { id: string; startTime: string; points: ColumnarPoints };

const M_PER_MI = 1609.344;

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371008.8, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Simple centred moving average for the noisy speed series. */
function smooth(values: (number | null)[], w: number): (number | null)[] {
  const half = Math.floor(w / 2);
  return values.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      const v = values[j];
      if (v !== null && Number.isFinite(v)) {
        s += v;
        n++;
      }
    }
    return n ? s / n : null;
  });
}

export function TrackCharts({ trackId, type, onHover }: { trackId: string; type: ActivityType; onHover?: (pos: { lat: number; lng: number } | null) => void }) {
  const [payload, setPayload] = useState<PointsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/tracks/${trackId}/points`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Track data failed (${r.status})`))))
      .then((d: PointsPayload) => alive && setPayload(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [trackId]);

  const series = useMemo(() => {
    if (!payload) return null;
    const c = payload.points;
    const n = c.t.length;
    // x axis: distance in miles (device distance if present, else cumulative haversine)
    const xs = new Array<number>(n);
    let cum = 0;
    for (let i = 0; i < n; i++) {
      if (c.dist && c.dist[i] !== null && c.dist[i] !== undefined) cum = c.dist[i];
      else if (i > 0) cum += haversine(c.lat[i - 1], c.lng[i - 1], c.lat[i], c.lng[i]);
      xs[i] = cum / M_PER_MI;
    }
    const ele = c.ele ? c.ele.map((v) => (v === null ? null : v * 3.28084)) : null;
    let spd: (number | null)[] | null = null;
    if (c.spd) spd = c.spd.map((v) => (v === null ? null : v));
    else {
      spd = new Array(n).fill(null);
      for (let i = 1; i < n; i++) {
        const dt = c.t[i] - c.t[i - 1];
        if (dt > 0) spd[i] = ((xs[i] - xs[i - 1]) * M_PER_MI) / dt;
      }
    }
    const paceBased = type === "RUN" || type === "HIKE";
    const speedSeries = smooth(spd, 9).map((v) => (v === null ? null : paceBased ? (v > 0.3 ? 1609.344 / v / 60 : null) : v * 2.23694));
    const hr = c.hr ?? null;
    const pwr = c.pwr ?? null;
    return { xs, ele, speedSeries, paceBased, hr, pwr, lat: c.lat, lng: c.lng };
  }, [payload, type]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!series) return <div className="h-40 bg-surface-alt animate-pulse rounded-theme" />;

  const color = ACTIVITY_COLOR[type];
  const hover = (idx: number | null) => onHover?.(idx === null ? null : { lat: series.lat[idx], lng: series.lng[idx] });
  const xAxis = { label: "Distance (mi)", values: (_u: unknown, vals: number[]) => vals.map((v) => v.toFixed(v < 10 ? 1 : 0)) };
  const common = { scales: { x: { time: false } }, cursor: { sync: { key: `track-${trackId}` }, y: false }, legend: { show: false } } as const;

  const rangeOf = (vals: (number | null)[], pad = 0.1): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) if (v !== null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) return [0, 1];
    const span = Math.max(hi - lo, 1);
    return [lo - span * pad, hi + span * pad];
  };
  const charts: { key: string; title: string; data: AlignedData; stroke: string; fill?: string; unit: string; paceFmt?: boolean; range?: [number, number] }[] = [];
  if (series.ele) charts.push({ key: "ele", title: "Elevation", data: [series.xs, series.ele] as AlignedData, stroke: color, fill: color + "33", unit: "ft" });
  charts.push({ key: "spd", title: series.paceBased ? "Pace" : "Speed", data: [series.xs, series.speedSeries] as AlignedData, stroke: "#1565c0", unit: series.paceBased ? "/mi" : "mph", paceFmt: series.paceBased, range: rangeOf(series.speedSeries, 0.25) });
  if (series.hr) charts.push({ key: "hr", title: "Heart rate", data: [series.xs, series.hr] as AlignedData, stroke: "#c62828", fill: "#c6282822", unit: "bpm" });
  if (series.pwr) charts.push({ key: "pwr", title: "Power", data: [series.xs, series.pwr] as AlignedData, stroke: "#6a1b9a", unit: "W" });

  return (
    <div className="space-y-3">
      {charts.map((ch) => (
        <div key={ch.key}>
          <div className="text-xs font-medium text-muted mb-1">
            {ch.title} <span className="font-normal">({ch.unit})</span>
          </div>
          <UPlotChart
            data={ch.data}
            height={ch.key === "ele" ? 170 : 120}
            onCursor={hover}
            options={{
              ...common,
              axes: [
                { ...xAxis, stroke: "#94a3b8", grid: { stroke: "#e2e8f0" } },
                { stroke: "#94a3b8", grid: { stroke: "#e2e8f0" }, size: 48, values: ch.paceFmt ? (_u: unknown, vals: number[]) => vals.map((v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`) : undefined },
              ],
              scales: { x: { time: false }, y: ch.paceFmt ? { dir: -1, range: ch.range } : {} },
              series: [{}, { stroke: ch.stroke, width: 1.5, fill: ch.fill, spanGaps: true, points: { show: false } }],
            }}
          />
        </div>
      ))}
    </div>
  );
}
