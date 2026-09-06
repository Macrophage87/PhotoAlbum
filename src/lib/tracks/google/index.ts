import { open } from "node:fs/promises";
import type { TrackPoint } from "../types";
import type { Window } from "./common";
import { detectGoogleFormat, type GoogleFormat } from "./detect";
import { parseRecords } from "./records";
import { parseSemanticHistory } from "./semantic";
import { parseTimelineExport } from "./timeline";

export async function readHead(filePath: string, bytes = 64 * 1024): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Parse any supported Google location export into time-sorted points inside the window. */
export async function parseGoogleExport(filePath: string, window: Window): Promise<{ format: GoogleFormat; points: TrackPoint[] }> {
  const head = (await readHead(filePath)).toString("utf8");
  const format = detectGoogleFormat(head);
  if (!format) throw new Error("Unrecognised Google location export. Expected Records.json, Timeline.json, or a Semantic Location History file.");
  let points: TrackPoint[];
  switch (format) {
    case "records":
      points = await parseRecords(filePath, window);
      break;
    case "semantic":
      points = await parseSemanticHistory(filePath, window);
      break;
    default:
      points = await parseTimelineExport(filePath, window, format);
  }
  points.sort((a, b) => a.t - b.t);
  return { format, points };
}

export type { GoogleFormat } from "./detect";
export { detectGoogleFormat } from "./detect";
