import type { TrackPoint } from "../types";
import { inWindow, parseLatLng, parseTime, point, type Window } from "./common";
import { streamJsonArray } from "./stream";

type Segment = {
  startTime?: string;
  endTime?: string;
  timelinePath?: { point?: string; time?: string; durationMinutesOffsetFromStartTime?: string | number }[];
  visit?: { topCandidate?: { placeLocation?: { latLng?: string } | string } };
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
  if (seg.visit) {
    const ll = latLngOf(seg.visit.topCandidate?.placeLocation);
    if (ll) {
      if (start !== null && inWindow(start, window)) out.push(point(start, ll[0], ll[1]));
      if (end !== null && end !== start && inWindow(end, window)) out.push(point(end, ll[0], ll[1]));
    }
    return out;
  }
  if (seg.activity) {
    const s = latLngOf(seg.activity.start), e = latLngOf(seg.activity.end);
    if (s && start !== null && inWindow(start, window)) out.push(point(start, s[0], s[1]));
    if (e && end !== null && inWindow(end, window)) out.push(point(end, e[0], e[1]));
  }
  return out;
}

/** Android export: { semanticSegments: [...] }. iOS export: a top-level array of the same segments. */
export async function parseTimelineExport(filePath: string, window: Window, shape: "timeline-android" | "timeline-ios"): Promise<TrackPoint[]> {
  const out: TrackPoint[] = [];
  for await (const raw of streamJsonArray(filePath, shape === "timeline-android" ? "semanticSegments" : "")) {
    out.push(...segmentToPoints(raw as Segment, window));
  }
  return out;
}
