import { isIPv4, isIPv6 } from "node:net";

/**
 * The caller's address as the reverse proxy in front of the app saw it, or null when there is no proxy saying.
 *
 * X-Forwarded-For is a list that anyone can start: nginx's `$proxy_add_x_forwarded_for` appends the peer it saw to
 * whatever the client sent, and Caddy replaces the header outright for a client it does not trust. Either way only
 * the right-most entry was written by our own proxy; everything to its left is the requester's word.
 */
export function forwardedClient(headers: Headers): string | null {
  const last = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  const raw = last || headers.get("x-real-ip")?.trim();
  return raw ? clientKey(raw) : null;
}

/**
 * One key per client. An IPv6 client is handed a whole /64 and can pick any address in it, so it is keyed by that
 * prefix; an IPv4-mapped address is its IPv4 address; a port or zone the proxy left on is dropped.
 */
export function clientKey(raw: string): string {
  let a = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  a = a.replace(/%.*$/, "").toLowerCase();
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return a.slice(0, 64);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  return `${expandIPv6(a).slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, "::" filled in (a trailing dotted IPv4 counts as two groups). */
function expandIPv6(a: string): string[] {
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const [p, q, r, s] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    a = a.slice(0, -v4[1]!.length) + `${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") as [string, string] : [a, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16));
}
