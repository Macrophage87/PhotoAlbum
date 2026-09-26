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
