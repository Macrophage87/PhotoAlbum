import type { TrackPoint } from "../types";
import { inWindow, parseLatLng, parseTime, point, type Window } from "./common";
import { MIN_VISIT_PROBABILITY, probability, type GoogleParse, type Stay } from "./stays";
import { streamJsonArray } from "./stream";

type Segment = {
  startTime?: string;
  endTime?: string;
  timelinePath?: { point?: string; time?: string; durationMinutesOffsetFromStartTime?: string | number }[];
  visit?: { hierarchyLevel?: number | string; probability?: number | string; topCandidate?: { placeLocation?: { latLng?: string } | string } };
  activity?: { start?: { latLng?: string } | string; end?: { latLng?: string } | string };
};

function latLngOf(v: unknown): [number, number] | null {
  if (typeof v === "string") return parseLatLng(v);
  if (v && typeof v === "object" && "latLng" in v) return parseLatLng((v as { latLng?: string }).latLng);
  return null;
}

/** Turn one on-device Timeline segment into points inside the window. */
export function segmentToPoints(seg: Segment, window: Window): TrackPoint[] {
  const out: TrackPoint[] = [];
  const start = parseTime(seg.startTime);
  const end = parseTime(seg.endTime);
  if (seg.timelinePath?.length) {
    for (const p of seg.timelinePath) {
      const ll = parseLatLng(p.point);
      if (!ll) continue;
      let t = parseTime(p.time);
      if (t === null && start !== null && p.durationMinutesOffsetFromStartTime !== undefined) t = start + Number(p.durationMinutesOffsetFromStartTime) * 60_000;
      if (t === null || !inWindow(t, window)) continue;
      out.push(point(t, ll[0], ll[1]));
    }
    return out;
  }
  // A visit's points come from segmentToStay, filled in only where nothing recorded covers it.
  if (seg.visit) return out;
  if (seg.activity) {
    const s = latLngOf(seg.activity.start), e = latLngOf(seg.activity.end);
    if (s && start !== null && inWindow(start, window)) out.push(point(start, s[0], s[1]));
    if (e && end !== null && inWindow(end, window)) out.push(point(end, e[0], e[1]));
  }
  return out;
}

/** A Timeline visit as a stay, or null for any other segment. */
export function segmentToStay(seg: Segment): Stay | null {
  if (!seg.visit || seg.timelinePath?.length) return null;
  const ll = latLngOf(seg.visit.topCandidate?.placeLocation);
  const start = parseTime(seg.startTime);
  if (!ll || start === null) return null;
  const p = probability(seg.visit.probability);
  return { start, end: parseTime(seg.endTime), lat: ll[0], lng: ll[1], level: Number(seg.visit.hierarchyLevel) || 0, fill: p === null || p >= MIN_VISIT_PROBABILITY };
}

/** Android export: { semanticSegments: [...] }. iOS export: a top-level array of the same segments. */
export async function parseTimelineExport(filePath: string, window: Window, shape: "timeline-android" | "timeline-ios"): Promise<GoogleParse> {
  const points: TrackPoint[] = [], stays: Stay[] = [];
  for await (const raw of streamJsonArray(filePath, shape === "timeline-android" ? "semanticSegments" : "")) {
    points.push(...segmentToPoints(raw as Segment, window));
    const stay = segmentToStay(raw as Segment);
    if (stay && stay.start <= window.endMs && (stay.end ?? stay.start) >= window.startMs) stays.push(stay);
  }
  return { points, stays };
}
