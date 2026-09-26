/**
 * The caller's address as the reverse proxy in front of the app saw it, or null when there is no proxy saying.
 *
 * X-Forwarded-For is a list that anyone can start: nginx's `$proxy_add_x_forwarded_for` appends the peer it saw to
 * whatever the client sent, and Caddy replaces the header outright for a client it does not trust. Either way only
 * the right-most entry was written by our own proxy; everything to its left is the requester's word.
 */
export function forwardedClient(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").pop()?.trim();
  if (last) return last.slice(0, 64);
  return headers.get("x-real-ip")?.trim().slice(0, 64) || null;
}
