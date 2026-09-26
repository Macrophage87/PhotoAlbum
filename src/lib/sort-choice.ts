import { cookies } from "next/headers";

/**
 * How to order a list for this request: what the address asks for, else what this device chose last time for this
 * kind of list, else the page's own default. Anything not among `allowed` is ignored, from either place.
 */
export async function sortChoice<V extends string>(sp: Record<string, string | string[] | undefined>, cookie: string, allowed: readonly V[], fallback: V, param = "order"): Promise<V> {
  const raw = Array.isArray(sp[param]) ? sp[param]![0] : sp[param];
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as V;
  const kept = (await cookies()).get(cookie)?.value;
  if (kept && (allowed as readonly string[]).includes(kept)) return kept as V;
  return fallback;
}

/** The lists that can be ordered, and the cookie each keeps its choice in. */
export const SORT_COOKIES = { activities: "activities-order", photos: "photos-order", trips: "trips-order" } as const;
export const PHOTO_SORTS = ["favorites", "oldest", "newest"] as const;
export type PhotoSort = (typeof PHOTO_SORTS)[number];
export const TRIP_SORTS = ["favorites", "newest", "oldest"] as const;
export type TripSort = (typeof TRIP_SORTS)[number];
export const DATE_SORTS = ["oldest", "newest"] as const;
export type DateSort = (typeof DATE_SORTS)[number];
