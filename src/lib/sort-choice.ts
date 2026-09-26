import { cookies } from "next/headers";

/**
 * How to order a list for this request: what the address asks for, else what this device chose last time for this
 * kind of list, else the page's own default. Anything not among `allowed` is ignored, from either place.
 */
export async function sortChoice<V extends string>(sp: Record<string, string | string[] | undefined>, cookie: string, allowed: readonly V[], fallback: V, param = "order"): Promise<V> {
  const raw = asked(sp, allowed, param);
  if (raw) return raw;
  const kept = (await cookies()).get(cookie)?.value;
  if (kept && (allowed as readonly string[]).includes(kept)) return kept as V;
  return fallback;
}

/** The order the address asks for, when it is one of `allowed`. */
function asked<V extends string>(sp: Record<string, string | string[] | undefined>, allowed: readonly V[], param: string): V | null {
  const raw = Array.isArray(sp[param]) ? sp[param]![0] : sp[param];
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as V) : null;
}

/** The lists that can be ordered, and the cookie each keeps its choice in. */
export const SORT_COOKIES = { activities: "activities-order", photos: "photos-order", trips: "trips-order" } as const;
export const PHOTO_SORTS = ["favorites", "oldest", "newest"] as const;
export type PhotoSort = (typeof PHOTO_SORTS)[number];
export const TRIP_SORTS = ["favorites", "newest", "oldest"] as const;
export type TripSort = (typeof TRIP_SORTS)[number];
export const DATE_SORTS = ["oldest", "newest"] as const;
export type DateSort = (typeof DATE_SORTS)[number];

/** A collection's photographs can also be shown in the order somebody arranged them. */
export const COLLECTION_SORTS = ["arranged", ...PHOTO_SORTS] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/**
 * How to order a collection's photographs. One somebody has arranged opens in that saved order, whatever this device
 * last chose on some other grid: the arrangement is a decision about this collection, the remembered order only a
 * habit. The others are still a click away, in the address. A collection nobody has arranged is ordered like any
 * other grid of photographs.
 */
export async function collectionSortChoice(sp: Record<string, string | string[] | undefined>, arranged: boolean): Promise<CollectionSort> {
  if (arranged) return asked(sp, COLLECTION_SORTS, "order") ?? "arranged";
  return sortChoice(sp, SORT_COOKIES.photos, PHOTO_SORTS, "favorites");
}
