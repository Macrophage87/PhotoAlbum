import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/**
 * A map of many photographs is worked out once and then answered from, view after view.
 *
 * Working one out means reading every placed photograph it holds, its day where it was taken, its spot spread from
 * its neighbours' and its ring in every legend: seconds, for an album of fifty thousand. Asking that again for every
 * pan made the map slow for everybody and let anybody, signed in or not, keep the server busy by dragging a map
 * about. So the answer is kept, per map and per way of seeing it, for as long as the album has not changed.
 *
 * "Not changed" is asked of the album itself on every request (`albumStamp`), cheaply: how many photographs, trips,
 * activities, collections, tracks and members there are, when each last changed (a photograph's latest change is
 * read from its index: taking one off any map, by the trash or by a new place, is a change to it), and exactly who
 * may see each trip and collection. What decides who sees what is compared whole rather than by time, so making a
 * trip private is never waited out. Anything the stamp could miss (a member renamed) is gone after `MAP_STATE_TTL_MS`.
 */
export const MAP_STATE_TTL_MS = 30_000;
/** Maps kept at once. Only the album's own and its biggest trips and collections are asked for a view at a time. */
const MAX_ENTRIES = 8;

type Entry = { stamp: string; at: number; value: Promise<unknown> };
const entries = new Map<string, Entry>();

/** A short, fixed-length name for something, so a key never holds a filter's words or a visitor's link tokens. */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** What the album looks like right now, as far as any map of it is concerned. */
async function albumStamp(): Promise<string> {
  const [row] = await db.$queryRaw<{ stamp: string }[]>`
    SELECT concat_ws('|',
      -- Asked apart, so the latest change comes straight off the index rather than from reading every row.
      (SELECT count(*) FROM "Photo") || ',' || coalesce((SELECT max("updatedAt") FROM "Photo")::text, ''),
      (SELECT count(*) || ',' || coalesce(max("updatedAt")::text, '') || ',' || coalesce(md5(string_agg(id || ':' || visibility || ':' || coalesce("shareToken", '') || ':' || timezone, ',' ORDER BY id)), '') FROM "Trip"),
      (SELECT count(*) || ',' || coalesce(max("updatedAt")::text, '') || ',' || coalesce(md5(string_agg(id || ':' || visibility || ':' || coalesce("shareToken", ''), ',' ORDER BY id)), '') FROM "Collection"),
      (SELECT count(*) || ',' || coalesce(max("createdAt")::text, '') FROM "CollectionItem"),
      (SELECT count(*) || ',' || coalesce(max("updatedAt")::text, '') FROM "Activity"),
      (SELECT count(*) || ',' || coalesce(max("createdAt")::text, '') FROM "Track"),
      (SELECT count(*)::text FROM "User")
    ) AS stamp`;
  return row.stamp;
}

/**
 * The map named by `key`, worked out by `build` unless it already has been since the album last changed. Two requests
 * for the same map at once share one working-out. `key` must say everything that changes what the map holds or
 * names for its viewer.
 */
export async function cachedMapState<T>(key: string, build: () => Promise<T>): Promise<T> {
  const stamp = await albumStamp();
  const now = Date.now();
  const kept = entries.get(key);
  if (kept && kept.stamp === stamp && now - kept.at < MAP_STATE_TTL_MS) {
    // The most recently used goes to the back of the line, so the one dropped for room is the one used longest ago.
    entries.delete(key);
    entries.set(key, kept);
    return kept.value as Promise<T>;
  }
  const entry: Entry = { stamp, at: now, value: build() };
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  // A working-out that failed is not kept: the next request tries again.
  entry.value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return entry.value as Promise<T>;
}

/** Forget every map worked out so far. For tests. */
export function forgetMapStates(): void {
  entries.clear();
}
