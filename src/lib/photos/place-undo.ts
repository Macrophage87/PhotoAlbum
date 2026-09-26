import { randomUUID } from "node:crypto";

/**
 * Each photograph's place just before a move on the placing screen — the position, its height, where it came from,
 * its name and who had set it — kept on the server so that Undo puts exactly that back. The browser holds only a
 * token for it: a place or a setter it sent itself could say anything.
 *
 * Kept in this process for an hour, which is as long as an Undo button is worth pressing. After a restart, or once
 * the hour is up, an Undo falls back to what the browser remembers, and records the member pressing it as whoever
 * set the places.
 */
export type PlaceSnapshot = { lat: number | null; lng: number | null; altitude: number | null; gpsSource: "EXIF" | "TRACK" | "MANUAL" | "SIDECAR" | "ESTIMATE" | null; placeName: string | null; placeSetById: string | null };
type Snapshot = { at: number; userId: string; places: Map<string, PlaceSnapshot> };

const TTL_MS = 60 * 60_000;
const holder = globalThis as unknown as { placeUndo?: Map<string, Snapshot> };
const store = (holder.placeUndo ??= new Map());

function prune(now: number) {
  for (const [token, s] of store) if (now - s.at > TTL_MS) store.delete(token);
}

export function rememberPlaces(userId: string, rows: ({ id: string } & PlaceSnapshot)[], now = Date.now()): string {
  prune(now);
  const token = randomUUID();
  store.set(token, { at: now, userId, places: new Map(rows.map(({ id, ...place }) => [id, place])) });
  return token;
}

/** The places remembered under a token, for the member who made the move; null when there is no such snapshot. */
export function placesFor(token: string | null | undefined, userId: string, now = Date.now()): Map<string, PlaceSnapshot> | null {
  prune(now);
  const s = token ? store.get(token) : undefined;
  return s && s.userId === userId ? s.places : null;
}
