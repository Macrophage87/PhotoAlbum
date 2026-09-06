import { gunzipSync, gzipSync } from "node:zlib";
import type { ColumnarPoints, TrackPoint } from "./types";

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Points -> compact columnar JSON -> gzip. `t` becomes seconds since the first point. */
export function encodePoints(points: TrackPoint[]): { blob: Buffer; startTime: Date; endTime: Date; flags: { ele: boolean; hr: boolean; cad: boolean; pwr: boolean } } {
  if (!points.length) throw new Error("encodePoints: no points");
  const t0 = points[0].t;
  const col: ColumnarPoints = { t: [], lat: [], lng: [] };
  const has = { ele: false, hr: false, cad: false, pwr: false, spd: false, dist: false };
  for (const p of points) {
    if (p.ele !== undefined) has.ele = true;
    if (p.hr !== undefined) has.hr = true;
    if (p.cad !== undefined) has.cad = true;
    if (p.pwr !== undefined) has.pwr = true;
    if (p.spd !== undefined) has.spd = true;
    if (p.dist !== undefined) has.dist = true;
  }
  if (has.ele) col.ele = [];
  if (has.hr) col.hr = [];
  if (has.cad) col.cad = [];
  if (has.pwr) col.pwr = [];
  if (has.spd) col.spd = [];
  if (has.dist) col.dist = [];
  for (const p of points) {
    col.t.push(Math.round((p.t - t0) / 100) / 10);
    col.lat.push(r6(p.lat));
    col.lng.push(r6(p.lng));
    if (col.ele) col.ele.push(p.ele === undefined ? null! : r1(p.ele));
    if (col.hr) col.hr.push(p.hr === undefined ? null! : Math.round(p.hr));
    if (col.cad) col.cad.push(p.cad === undefined ? null! : Math.round(p.cad));
    if (col.pwr) col.pwr.push(p.pwr === undefined ? null! : Math.round(p.pwr));
    if (col.spd) col.spd.push(p.spd === undefined ? null! : Math.round(p.spd * 100) / 100);
    if (col.dist) col.dist.push(p.dist === undefined ? null! : r1(p.dist));
  }
  return { blob: gzipSync(Buffer.from(JSON.stringify(col)), { level: 6 }), startTime: new Date(t0), endTime: new Date(points[points.length - 1].t), flags: { ele: has.ele, hr: has.hr, cad: has.cad, pwr: has.pwr } };
}

export function decodePoints(blob: Buffer | Uint8Array): ColumnarPoints {
  return JSON.parse(gunzipSync(Buffer.from(blob)).toString("utf8")) as ColumnarPoints;
}

/** Columnar back to point objects (used for interpolation and re-stats). */
export function columnarToPoints(col: ColumnarPoints, startTime: Date): TrackPoint[] {
  const t0 = startTime.getTime();
  const out: TrackPoint[] = new Array(col.t.length);
  for (let i = 0; i < col.t.length; i++) {
    const p: TrackPoint = { t: t0 + col.t[i] * 1000, lat: col.lat[i], lng: col.lng[i] };
    if (col.ele && col.ele[i] !== null) p.ele = col.ele[i];
    if (col.hr && col.hr[i] !== null) p.hr = col.hr[i];
    if (col.cad && col.cad[i] !== null) p.cad = col.cad[i];
    if (col.pwr && col.pwr[i] !== null) p.pwr = col.pwr[i];
    if (col.spd && col.spd[i] !== null) p.spd = col.spd[i];
    if (col.dist && col.dist[i] !== null) p.dist = col.dist[i];
    out[i] = p;
  }
  return out;
}
