import type { TrackPoint } from "../types";
import { e7, inWindow, MAX_ACCURACY_M, parseTime, point, type Window } from "./common";
import { streamJsonArray } from "./stream";

/** Takeout `Records.json`: { locations: [{ latitudeE7, longitudeE7, timestamp|timestampMs, accuracy?, altitude? }] } */
export async function parseRecords(filePath: string, window: Window): Promise<TrackPoint[]> {
  const out: TrackPoint[] = [];
  for await (const raw of streamJsonArray(filePath, "locations")) {
    const r = raw as Record<string, unknown>;
    const t = parseTime(r.timestamp ?? r.timestampMs);
    if (t === null || !inWindow(t, window)) continue;
    const lat = e7(r.latitudeE7), lng = e7(r.longitudeE7);
    if (lat === null || lng === null) continue;
    if (typeof r.accuracy === "number" && r.accuracy > MAX_ACCURACY_M) continue;
    out.push(point(t, lat, lng, typeof r.altitude === "number" ? { ele: r.altitude } : undefined));
  }
  return out;
}
