import { db } from "@/lib/db";
import { thinLine } from "@/lib/tracks/simplify";

/** Points per track on the map of everything: plenty at the zoom that shows a whole trip or more. */
export const OVERVIEW_POINTS = 300;

/**
 * Each track's line for the map of everything: its stored short copy (`Track.overview`), or for a track saved
 * before there was one, evenly spaced points of the full line.
 *
 * A stored line can have five thousand points, and that map used to be read and sent every one of every track: a
 * hundred hikes came to tens of megabytes on every visit, nearly all of it points drawn on top of each other at the
 * zoom it opens at. A track's own map and its activity's page still draw the whole line.
 */
export async function overviewLines(tracks: { id: string; overview: unknown }[]): Promise<Map<string, [number, number][]>> {
  const lines = new Map<string, [number, number][]>();
  const missing: string[] = [];
  for (const t of tracks) {
    if (Array.isArray(t.overview)) lines.set(t.id, t.overview as [number, number][]);
    else missing.push(t.id);
  }
  if (missing.length) {
    for (const t of await db.track.findMany({ where: { id: { in: missing } }, select: { id: true, simplified: true } })) {
      lines.set(t.id, thinLine(Array.isArray(t.simplified) ? (t.simplified as [number, number][]) : [], OVERVIEW_POINTS));
    }
  }
  // Five decimal places is about a metre, far finer than a line on this map is drawn, and half the characters.
  const trim = (v: number) => Math.round(v * 1e5) / 1e5;
  for (const [id, line] of lines) lines.set(id, line.map(([lat, lng]) => [trim(lat), trim(lng)]));
  return lines;
}
