import { randomUUID } from "node:crypto";

/**
 * Who had set each photograph's place just before a move on the placing screen, kept on the server so that Undo can
 * put exactly that back. The browser holds only a token for it: a setter it sent itself could name anybody.
 *
 * Kept in this process for an hour, which is as long as an Undo button is worth pressing. After a restart, or once
 * the hour is up, an Undo still restores the places, and records the member pressing it as whoever set them.
 */
type Snapshot = { at: number; userId: string; setters: Map<string, string | null> };

const TTL_MS = 60 * 60_000;
const holder = globalThis as unknown as { placeUndo?: Map<string, Snapshot> };
const store = (holder.placeUndo ??= new Map());

function prune(now: number) {
  for (const [token, s] of store) if (now - s.at > TTL_MS) store.delete(token);
}

export function rememberSetters(userId: string, rows: { id: string; placeSetById: string | null }[], now = Date.now()): string {
  prune(now);
  const token = randomUUID();
  store.set(token, { at: now, userId, setters: new Map(rows.map((r) => [r.id, r.placeSetById])) });
  return token;
}

/** The setters remembered under a token, for the member who made the move; null when there is no such snapshot. */
export function settersFor(token: string | null | undefined, userId: string, now = Date.now()): Map<string, string | null> | null {
  prune(now);
  const s = token ? store.get(token) : undefined;
  return s && s.userId === userId ? s.setters : null;
}
