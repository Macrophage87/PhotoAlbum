import type { DayGroup } from "./build";

/**
 * Which way a timeline runs. A trip reads best from the morning it began, like a story; an album somebody opens to
 * see what is new reads best from the latest day back. Both are offered everywhere, and the choice is remembered on
 * the device it was made on.
 */
export type TimelineOrder = "oldest" | "newest";

export const TIMELINE_ORDER_COOKIE = "timeline-order";

export function parseTimelineOrder(value: unknown): TimelineOrder | null {
  return value === "newest" || value === "oldest" ? value : null;
}

/**
 * The same timeline run the other way: the latest day first, and within each day the latest moment first — the
 * last outing above the first, the last photograph of a run above the first. Photographs with no date stay at the
 * end whichever way it runs, since "no date" is neither early nor late.
 */
export function orderTimeline<P, A>(groups: DayGroup<P, A>[], order: TimelineOrder): DayGroup<P, A>[] {
  if (order === "oldest") return groups;
  const dated = groups.filter((g) => g.dayKey !== null);
  const undated = groups.filter((g) => g.dayKey === null);
  const flip = (g: DayGroup<P, A>): DayGroup<P, A> => ({ ...g, items: [...g.items].reverse().map((i) => ({ ...i, photos: [...i.photos].reverse() })) });
  return [...[...dated].reverse().map(flip), ...undated.map(flip)];
}

/**
 * The first and last moments of a run of photographs, earliest first whichever way the timeline runs: "9:00 AM –
 * 3:30 PM" is a span of time, and a newest-first page printing it backwards reads as nonsense.
 */
export function timeSpan<P extends { takenAt: Date | null }>(photos: P[]): { first: P; last: P } | null {
  const dated = photos.filter((p) => p.takenAt);
  if (dated.length === 0) return null;
  let first = dated[0];
  let last = dated[0];
  for (const p of dated) {
    if (p.takenAt! < first.takenAt!) first = p;
    if (p.takenAt! > last.takenAt!) last = p;
  }
  return { first, last };
}
