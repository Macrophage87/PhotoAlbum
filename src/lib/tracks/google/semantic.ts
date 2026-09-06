import type { TrackPoint } from "../types";
import { e7, inWindow, parseTime, point, type Window } from "./common";
import { streamJsonArray } from "./stream";

type E7 = { latitudeE7?: number; longitudeE7?: number; latE7?: number; lngE7?: number };
type Duration = { startTimestamp?: string; endTimestamp?: string; startTimestampMs?: string; endTimestampMs?: string };
type TimelineObject = {
  activitySegment?: {
    startLocation?: E7;
    endLocation?: E7;
    duration?: Duration;
    waypointPath?: { waypoints?: E7[] };
    simplifiedRawPath?: { points?: (E7 & { timestampMs?: string; timestamp?: string })[] };
  };
  placeVisit?: { location?: E7; duration?: Duration };
};

const ll = (o: E7 | undefined): [number, number] | null => {
  if (!o) return null;
  const lat = e7(o.latitudeE7 ?? o.latE7), lng = e7(o.longitudeE7 ?? o.lngE7);
  return lat === null || lng === null ? null : [lat, lng];
};
const dur = (d: Duration | undefined) => ({
  start: parseTime(d?.startTimestamp ?? d?.startTimestampMs),
  end: parseTime(d?.endTimestamp ?? d?.endTimestampMs),
});

/** One Semantic Location History timeline object -> points inside the window. */
export function timelineObjectToPoints(obj: TimelineObject, window: Window): TrackPoint[] {
  const out: TrackPoint[] = [];
  if (obj.activitySegment) {
    const a = obj.activitySegment;
    const { start, end } = dur(a.duration);
    const raw = a.simplifiedRawPath?.points ?? [];
    if (raw.length) {
      for (const p of raw) {
        const t = parseTime(p.timestampMs ?? p.timestamp);
        const c = ll(p);
        if (t === null || !c || !inWindow(t, window)) continue;
        out.push(point(t, c[0], c[1]));
      }
      return out;
    }
    if (start === null || end === null) return out;
    const path: [number, number][] = [];
    const s = ll(a.startLocation), e = ll(a.endLocation);
    if (s) path.push(s);
    for (const w of a.waypointPath?.waypoints ?? []) {
      const c = ll(w);
      if (c) path.push(c);
    }
    if (e) path.push(e);
    // Spread waypoints evenly across the segment's duration.
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? start : start + ((end - start) * i) / (n - 1);
      if (inWindow(t, window)) out.push(point(Math.round(t), path[i][0], path[i][1]));
    }
    return out;
  }
  if (obj.placeVisit) {
    const c = ll(obj.placeVisit.location);
    const { start, end } = dur(obj.placeVisit.duration);
    if (c && start !== null && inWindow(start, window)) out.push(point(start, c[0], c[1]));
    if (c && end !== null && end !== start && inWindow(end, window)) out.push(point(end, c[0], c[1]));
  }
  return out;
}

export async function parseSemanticHistory(filePath: string, window: Window): Promise<TrackPoint[]> {
  const out: TrackPoint[] = [];
  for await (const raw of streamJsonArray(filePath, "timelineObjects")) out.push(...timelineObjectToPoints(raw as TimelineObject, window));
  return out;
}
