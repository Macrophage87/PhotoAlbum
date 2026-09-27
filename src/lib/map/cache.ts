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
 * "Not changed" is the map's version (`MapVersion`, one row), which triggers bump in the same transaction as any
 * change to something a map shows, and only then: a face found or a caption written leaves every map standing.
 *
 * A change that only adds to a map (a photograph given its first place, filed on a trip, made ready) may show a little
 * late: while the new map is worked out, the kept one answers, for anybody. A change that takes something off a map or
 * alters what it said (the version's `access` part: a place cleared, a trip made private, a track deleted, a name
 * changed; see the map_version migration) is never answered from a map kept from before it: the next request waits
 * for a map worked out after it, and requests meanwhile share that one working-out. How late an addition may be is
 * capped twice: a working-out is started at most every `REBUILD_EVERY_MS` per map, so an import going on does not
 * keep the server working maps out back to back, and no kept map older than `MAP_STATE_TTL_MS` is ever answered
 * from while something has changed since. One the album has not changed under is simply kept, however old. `fresh` asks never to be answered from a map older than the album (the placing screen, which must see what it
 * just placed).
 *
 * A map small enough to send whole is not kept at all: it is asked for once per visit, never a view at a time.
 */
/** The oldest a kept map may be, from when it was worked out, and still be answered from. */
export const MAP_STATE_TTL_MS = 60_000;
/** At most one working-out of a map this often while only additions are waiting for it. */
export const REBUILD_EVERY_MS = 5_000;
/** A working-out running longer than this is taken to have hung: it is neither waited for nor lets one wait. */
export const BUILD_GIVE_UP_MS = 30_000;
/** Maps kept at once. Only the album's own and its biggest trips and collections are asked for a view at a time. */
const MAX_ENTRIES = 8;
/** Maps last found small enough not to keep, remembered so they skip the version check too. */
const MAX_SMALL = 256;

type Version = { version: bigint; access: bigint };
/** What waiting for a working-out gives when it runs out of time. */
const LATE = Symbol("late");
type Slot = { kept?: Version & { at: number; value: unknown }; building?: Version & { at: number; promise: Promise<unknown> }; lastStart: number };
const slots = new Map<string, Slot>();
const small = new Set<string>();

/** A short, fixed-length name for something, so a key never holds a filter's words or a visitor's link tokens. */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** The map's version now, or null if its row is missing (then nothing is kept, rather than kept forever). */
async function mapVersion(): Promise<Version | null> {
  const [row] = await db.$queryRaw<Version[]>`SELECT "version", "access" FROM "MapVersion" WHERE "id" = 1`;
  return row ?? null;
}

/**
 * The map named by `key`, worked out by `build` unless it already has been since the map's version last moved.
 * `key` must say everything that changes what the map holds or names for its viewer. `keep` says whether a map is
 * big enough to be worth keeping.
 */
export async function cachedMapState<T>(key: string, build: () => Promise<T>, { keep, fresh = false }: { keep: (value: T) => boolean; fresh?: boolean }): Promise<T> {
  if (small.has(key)) {
    const value = await build();
    if (keep(value)) small.delete(key);
    return value;
  }
  const now = await mapVersion();
  if (!now) return build();
  const slot = slots.get(key) ?? { lastStart: 0 };
  // The most recently used goes to the back of the line, so the one dropped for room is the one used longest ago.
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_ENTRIES) slots.delete(slots.keys().next().value!);

  const at = Date.now();
  const building = slot.building && at - slot.building.at < BUILD_GIVE_UP_MS ? slot.building : undefined;
  const kept = slot.kept;
  const young = kept !== undefined && at - kept.at < MAP_STATE_TTL_MS;

  const rebuild = () => {
    const promise = build().then((value) => {
      if (!keep(value)) {
        if (slots.get(key) === slot) slots.delete(key);
        if (small.size >= MAX_SMALL) small.clear();
        small.add(key);
      } else if (!slot.kept || slot.kept.version <= now.version) {
        // Never over one worked out from a later version, should two working-outs end out of order.
        slot.kept = { ...now, at, value };
      }
      return value;
    });
    slot.building = { ...now, at, promise };
    slot.lastStart = at;
    const done = () => {
      if (slot.building?.promise === promise) slot.building = undefined;
    };
    promise.then(done, done);
    return promise;
  };
  /** Work the map out again without anybody waiting for it; a failure is logged, and the kept map stands. */
  const renew = () => {
    if (building || at - slot.lastStart < REBUILD_EVERY_MS) return;
    rebuild().catch((error: unknown) => console.error("Working out a map again failed; the kept one stands.", error));
  };

  // Exactly the album as it is, however long ago it was worked out: nothing has changed, so there is nothing to work
  // out again, and it counts as new from now.
  if (kept && kept.version === now.version) {
    kept.at = at;
    return kept.value as T;
  }
  // Only additions since: answered from while the new one is worked out.
  if (kept && young && !fresh && kept.access === now.access) {
    renew();
    return kept.value as T;
  }
  // Otherwise wait, sharing a working-out begun since the last thing taken off a map (asked fresh: begun at this version),
  // but only until it would count as hung: then it is left to itself, and the map is worked out again.
  if (building && (fresh ? building.version === now.version : building.access === now.access)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof LATE>((resolve) => (timer = setTimeout(() => resolve(LATE), Math.max(0, BUILD_GIVE_UP_MS - (at - building.at)))));
    const first = await Promise.race([building.promise as Promise<T>, late]).finally(() => clearTimeout(timer));
    return first === LATE ? rebuild() : first;
  }
  return rebuild();
}

/** Forget every map worked out so far. For tests. */
export function forgetMapStates(): void {
  slots.clear();
  small.clear();
}
