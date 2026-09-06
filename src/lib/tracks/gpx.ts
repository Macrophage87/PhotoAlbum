import { XMLParser } from "fast-xml-parser";
import type { ParsedTrack, TrackPoint } from "./types";
import { sportToActivityType } from "./sport";

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true,
  removeNSPrefix: false,
  isArray: (name) => ["trk", "trkseg", "trkpt"].includes(name),
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Find a value by local name anywhere in an extensions subtree, whatever the namespace prefix. */
function findByLocalName(node: unknown, local: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  for (const [k, v] of Object.entries(node as Node)) {
    if (k.startsWith("@_")) continue;
    const name = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
    if (name === local) return typeof v === "object" && v !== null && "#text" in (v as Node) ? (v as Node)["#text"] : v;
    const deeper = findByLocalName(v, local);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return text((v as Node)["#text"]);
  return String(v);
}

/** Parse a GPX document into one ParsedTrack per <trk>. Routes/waypoints are ignored. */
export function parseGpx(xml: string): ParsedTrack[] {
  const doc = parser.parse(xml) as Node;
  const gpx = (doc.gpx ?? doc) as Node;
  const tracks: ParsedTrack[] = [];
  for (const [i, trk] of asArray(gpx.trk as Node | Node[]).entries()) {
    const points: TrackPoint[] = [];
    for (const seg of asArray(trk.trkseg as Node | Node[])) {
      for (const pt of asArray(seg.trkpt as Node | Node[])) {
        const lat = num(pt["@_lat"]);
        const lng = num(pt["@_lon"]);
        const time = text(pt.time);
        if (lat === undefined || lng === undefined || !time) continue;
        const t = Date.parse(time);
        if (!Number.isFinite(t)) continue;
        const p: TrackPoint = { t, lat, lng };
        const ele = num(text(pt.ele));
        if (ele !== undefined) p.ele = ele;
        const ext = pt.extensions;
        if (ext) {
          const hr = num(findByLocalName(ext, "hr"));
          const cad = num(findByLocalName(ext, "cad"));
          const pwr = num(findByLocalName(ext, "power") ?? findByLocalName(ext, "pwr"));
          const temp = num(findByLocalName(ext, "atemp"));
          const spd = num(findByLocalName(ext, "speed"));
          const dist = num(findByLocalName(ext, "distance"));
          if (hr !== undefined) p.hr = hr;
          if (cad !== undefined) p.cad = cad;
          if (pwr !== undefined) p.pwr = pwr;
          if (temp !== undefined) p.temp = temp;
          if (spd !== undefined) p.spd = spd;
          if (dist !== undefined) p.dist = dist;
        }
        points.push(p);
      }
    }
    const sportRaw = text(trk.type);
    const name = text(trk.name) ?? text((gpx.metadata as Node | undefined)?.name) ?? `Track ${i + 1}`;
    if (points.length) tracks.push({ name, points, sport: sportToActivityType(sportRaw), sportRaw });
  }
  return tracks;
}
