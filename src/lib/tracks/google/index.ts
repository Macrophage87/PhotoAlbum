import { open } from "node:fs/promises";
import type { TrackPoint } from "../types";
import type { Window } from "./common";
import { detectGoogleFormat, type GoogleFormat } from "./detect";
import { parseRecords } from "./records";
import { parseSemanticHistory } from "./semantic";
import { parseTimelineExport } from "./timeline";
import { fillStays, type GoogleParse } from "./stays";

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

/**
 * Parse any supported Google location export into time-sorted points inside the window. `recorded` counts the points
 * the export itself holds; the rest are filled in across visits.
 */
export async function parseGoogleExport(filePath: string, window: Window): Promise<{ format: GoogleFormat; points: TrackPoint[]; recorded: number }> {
  const head = (await readHead(filePath)).toString("utf8");
  const format = detectGoogleFormat(head);
  if (!format) throw new Error("Unrecognized Google location export. Expected Records.json, Timeline.json, or a Semantic Location History file.");
  let parsed: GoogleParse;
  switch (format) {
    case "records":
      parsed = { points: await parseRecords(filePath, window), stays: [] };
      break;
    case "semantic":
      parsed = await parseSemanticHistory(filePath, window);
      break;
    default:
      parsed = await parseTimelineExport(filePath, window, format);
  }
  return { format, points: fillStays(parsed.points, parsed.stays, window), recorded: parsed.points.length };
}

export type { GoogleFormat } from "./detect";
export { detectGoogleFormat } from "./detect";
