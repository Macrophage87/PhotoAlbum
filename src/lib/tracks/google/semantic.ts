import type { TrackPoint } from "../types";
import { e7, inWindow, parseTime, point, type Window } from "./common";
import { MIN_VISIT_PROBABILITY, probability, type GoogleParse, type Stay } from "./stays";
import { streamJsonArray } from "./stream";

type E7 = { latitudeE7?: number; longitudeE7?: number; latE7?: number; lngE7?: number };
type Duration = { startTimestamp?: string; endTimestamp?: string; startTimestampMs?: string; endTimestampMs?: string };
type PlaceVisit = { location?: E7; duration?: Duration; visitConfidence?: number | string; childVisits?: PlaceVisit[] };
type TimelineObject = {
  activitySegment?: {
    startLocation?: E7;
    endLocation?: E7;
    duration?: Duration;
    waypointPath?: { waypoints?: E7[] };
    simplifiedRawPath?: { points?: (E7 & { timestampMs?: string; timestamp?: string })[] };
  };
  placeVisit?: PlaceVisit;
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
  // A placeVisit's points come from timelineObjectToStays, filled in only where nothing recorded covers it.
  return out;
}

/** A placeVisit and the visits nested in it (a shop inside a shopping centre) as stays. */
export function timelineObjectToStays(obj: TimelineObject): Stay[] {
  const out: Stay[] = [];
  const walk = (v: PlaceVisit, level: number) => {
    const c = ll(v.location);
    const { start, end } = dur(v.duration);
    const p = probability(v.visitConfidence);
    if (c && start !== null) out.push({ start, end, lat: c[0], lng: c[1], level, fill: p === null || p >= MIN_VISIT_PROBABILITY });
    for (const child of v.childVisits ?? []) walk(child, level + 1);
  };
  if (obj.placeVisit) walk(obj.placeVisit, 0);
  return out;
}

export async function parseSemanticHistory(filePath: string, window: Window): Promise<GoogleParse> {
  const points: TrackPoint[] = [], stays: Stay[] = [];
  for await (const raw of streamJsonArray(filePath, "timelineObjects")) {
    points.push(...timelineObjectToPoints(raw as TimelineObject, window));
    for (const stay of timelineObjectToStays(raw as TimelineObject)) if (stay.start <= window.endMs && (stay.end ?? stay.start) >= window.startMs) stays.push(stay);
  }
  return { points, stays };
}
