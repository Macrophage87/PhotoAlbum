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
 * prefix; an IPv6 address that only carries an IPv4 one (mapped, translated, or NAT64) is keyed by the IPv4 address;
 * a port or zone the proxy left on is dropped.
 */
export function clientKey(raw: string): string {
  let a = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  a = a.replace(/%.*$/, "").toLowerCase();
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return a.slice(0, 64);
  const g = expandIPv6(a);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded =
    (zero(0, 5) && g[5] === 0xffff) || // ::ffff:a.b.c.d, IPv4-mapped
    (zero(0, 4) && g[4] === 0xffff && g[5] === 0) || // ::ffff:0:a.b.c.d, IPv4-translated
    (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)); // 64:ff9b::a.b.c.d, NAT64
  if (embedded) return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The wider network a client key belongs to, for a second, looser limit: one site is commonly handed a /48, which
 * holds 65,536 /64s. An IPv4 client is its own network.
 */
export function clientNetwork(key: string): string {
  const v6 = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return v6 ? `${v6[1]}::/48` : key;
}

/** The eight 16-bit groups of an IPv6 address, "::" filled in (a trailing dotted IPv4 counts as two groups). */
function expandIPv6(a: string): number[] {
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const [p, q, r, s] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    a = a.slice(0, -v4[1]!.length) + `${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? (a.split("::") as [string, string]) : [a, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((x) => parseInt(x, 16) || 0);
}

let warnedNoClient = false;

/**
 * Say once, in production, that a request came with no client address. Behind the reverse proxy the docs describe
 * that never happens, so it means the proxy is not passing X-Forwarded-For (or somebody is reaching the app's port
 * directly), and every such request is sharing one sign-in rate-limit bucket.
 */
export function warnOnceIfNoClient(client: string | null, log: (message: string) => void = console.warn): void {
  if (client || warnedNoClient || process.env.NODE_ENV !== "production") return;
  warnedNoClient = true;
  log(
    "[sign-in] a request arrived without X-Forwarded-For or X-Real-IP, so all such requests share one rate-limit bucket. " +
      "If the album is behind a reverse proxy, make it pass X-Forwarded-For; check the app's port is not reachable directly (APP_BIND).",
  );
}
