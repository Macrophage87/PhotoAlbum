import { randomUUID } from "node:crypto";

/**
 * Where each photograph was just before a move on the placing screen, and who had set it, kept on the server so that
 * Undo can put exactly that back. The browser holds only a token for it: anything it sent itself could name anybody,
 * claim a camera's position for a tap, or make up a height.
 *
 * Kept in this process for an hour, which is as long as an Undo button is worth pressing. After a restart, or once
 * the hour is up, an Undo still puts the places back, but as the member pressing it placing them by hand.
 */
export type PlaceSnapshot = {
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  gpsSource: "EXIF" | "TRACK" | "MANUAL" | "SIDECAR" | "ESTIMATE" | null;
  placeName: string | null;
  placeSetById: string | null;
};
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
  store.set(token, { at: now, userId, places: new Map(rows.map(({ id, lat, lng, altitude, gpsSource, placeName, placeSetById }) => [id, { lat, lng, altitude, gpsSource, placeName, placeSetById }])) });
  return token;
}

/** The places remembered under a token, for the member who made the move; null when there is no such snapshot. */
export function placesFor(token: string | null | undefined, userId: string, now = Date.now()): Map<string, PlaceSnapshot> | null {
  prune(now);
  const s = token ? store.get(token) : undefined;
  return s && s.userId === userId ? s.places : null;
}

/** Undo is pressed once: a note that has been used is dropped, so it cannot put the places back over later changes. */
export function forgetPlaces(token: string | null | undefined): void {
  if (token) store.delete(token);
}
