import { cookies } from "next/headers";
import { parseTimelineOrder, TIMELINE_ORDER_COOKIE, type TimelineOrder } from "./order";

/**
 * Which way to run a timeline for this request: what the address asks for, else what this device chose last time,
 * else the page's own default.
 */
export async function timelineOrderFor(sp: Record<string, string | string[] | undefined>, fallback: TimelineOrder): Promise<TimelineOrder> {
  const asked = parseTimelineOrder(Array.isArray(sp.order) ? sp.order[0] : sp.order);
  if (asked) return asked;
  const kept = parseTimelineOrder((await cookies()).get(TIMELINE_ORDER_COOKIE)?.value);
  return kept ?? fallback;
}
