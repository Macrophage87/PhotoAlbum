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
 * change to something a map shows, and only then: a face found or a caption written leaves every map standing. Its
 * `access` part counts only the changes that can take something off a map for somebody. While that is unchanged, a
 * map kept from before a change is still one its viewer may see, and it is answered from while the new one is worked
 * out, one working-out at a time, so an import going on does not make every pan wait. After such a change nothing
 * kept is served until the new map is ready. `fresh` asks never to be answered from a map older than the album (the
 * placing screen, which must see what it just placed).
 *
 * A map small enough to send whole is not kept at all: it is asked for once per visit, never a view at a time.
 */
export const MAP_STATE_TTL_MS = 60_000;
/** Maps kept at once. Only the album's own and its biggest trips and collections are asked for a view at a time. */
const MAX_ENTRIES = 8;
/** Maps last found small enough not to keep, remembered so they skip the version check too. */
const MAX_SMALL = 256;

type Version = { version: bigint; access: bigint };
type Slot = { kept?: Version & { at: number; value: unknown }; building?: Version & { promise: Promise<unknown> } };
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
  const slot = slots.get(key) ?? {};
  // The most recently used goes to the back of the line, so the one dropped for room is the one used longest ago.
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_ENTRIES) slots.delete(slots.keys().next().value!);

  const kept = slot.kept;
  if (kept && kept.version === now.version && Date.now() - kept.at < MAP_STATE_TTL_MS) return kept.value as T;

  const rebuild = () => {
    const started = Date.now();
    const promise = build().then((value) => {
      if (!keep(value)) {
        if (slots.get(key) === slot) slots.delete(key);
        if (small.size >= MAX_SMALL) small.clear();
        small.add(key);
      } else if (!slot.kept || slot.kept.version <= now.version) {
        // Never over one worked out from a later version, should two working-outs end out of order.
        slot.kept = { ...now, at: started, value };
      }
      return value;
    });
    slot.building = { ...now, promise };
    const done = () => {
      if (slot.building?.promise === promise) slot.building = undefined;
    };
    promise.then(done, done);
    return promise;
  };

  // Nothing has been taken off the map for anybody since it was kept: answer from it while the new one is worked out,
  // and start that only if nothing is being worked out already.
  if (kept && !fresh && kept.access === now.access) {
    if (!slot.building) rebuild().catch(() => {});
    return kept.value as T;
  }
  // Otherwise wait for the new one. A working-out begun at this version holds every change up to it, so whoever asks
  // now shares it rather than starting another.
  if (slot.building && slot.building.version === now.version) return slot.building.promise as Promise<T>;
  return rebuild();
}

/** Forget every map worked out so far. For tests. */
export function forgetMapStates(): void {
  slots.clear();
  small.clear();
}
