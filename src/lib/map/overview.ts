import { db } from "@/lib/db";
import { shortenLine } from "@/lib/tracks/simplify";

/** Points per track on the map of everything: plenty at the zoom that shows a whole trip or more. */
export const OVERVIEW_POINTS = 300;

/** The short copy of a stored line, the same way a track works it out when it is saved. */
export function overviewOf(simplified: unknown): [number, number][] {
  return shortenLine(Array.isArray(simplified) ? (simplified as [number, number][]) : [], OVERVIEW_POINTS);
}

/**
 * Each track's line for the map of everything: its stored short copy (`Track.overview`), or for a track saved
 * before there was one, worked out from the full line now and kept for next time.
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
    const worked: { id: string; overview: [number, number][] }[] = [];
    for (const t of await db.track.findMany({ where: { id: { in: missing } }, select: { id: true, simplified: true } })) {
      const overview = overviewOf(t.simplified);
      lines.set(t.id, overview);
      worked.push({ id: t.id, overview });
    }
    // Kept in the background: the map does not wait on it, and if it fails the next visit simply works it out again.
    void saveOverviews(worked).catch(() => {});
  }
  // Five decimal places is about a metre, far finer than a line on this map is drawn, and half the characters.
  const trim = (v: number) => Math.round(v * 1e5) / 1e5;
  for (const [id, line] of lines) lines.set(id, line.map(([lat, lng]) => [trim(lat), trim(lng)]));
  return lines;
}

/** Store worked-out short lines, one small write at a time so no other use of the tracks waits behind a batch. */
export async function saveOverviews(worked: { id: string; overview: [number, number][] }[]): Promise<void> {
  for (const w of worked) await db.track.updateMany({ where: { id: w.id }, data: { overview: w.overview } });
}
