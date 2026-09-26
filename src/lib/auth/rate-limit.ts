import { clientNetwork } from "./client-address";

/**
 * Small in-memory throttle for actions that send email. One process per deployment is the
 * normal case for this app, so a Map is enough; it resets on restart, which is acceptable.
 */
type Bucket = { count: number; windowStart: number };

export class RateLimiter {
  // Kept in the order windows opened (a fresh window is re-inserted at the end), so the oldest bucket is always first.
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Whether the key has room for one more call, without recording anything. */
  hasRoom(key: string): boolean {
    const b = this.buckets.get(key);
    return !b || this.now() - b.windowStart >= this.windowMs || b.count < this.max;
  }

  /** Returns true when the call is allowed and records it; false when the key is over its limit. */
  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || t - b.windowStart >= this.windowMs) {
      this.buckets.delete(key);
      this.buckets.set(key, { count: 1, windowStart: t });
      this.evict(t);
      return true;
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }

  /**
   * Drop expired buckets from the front, then the oldest live ones while over capacity. Each bucket is removed at
   * most once, so a flood of new keys costs constant time per call instead of a walk over the whole map.
   */
  private evict(t: number) {
    for (const [k, b] of this.buckets) {
      if (t - b.windowStart < this.windowMs && this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Sign-in requests. Per client: 20 every 10 minutes; per wider network (an IPv6 /48, or the IPv4 address again):
 * 60. How much mail one address can receive is bounded separately and without a lockout, by the cap on its live
 * links (MAX_OUTSTANDING_LINKS in magic-link.ts), and all sign-in mail together by SIGN_IN_MAIL_PER_HOUR.
 */
export const signInPerClient = new RateLimiter(20, 10 * 60 * 1000);
export const signInPerNetwork = new RateLimiter(60, 10 * 60 * 1000);

export type SignInLimits = { perClient: RateLimiter; perNetwork: RateLimiter };

/**
 * Whether this client may ask for another sign-in link. It is best-effort: it only applies when a proxy supplies a
 * client address, so that an install without a proxy does not put every visitor in one shared bucket. Nothing here
 * is keyed on the address asked for, so nobody's requests can use up anybody else's.
 */
export function allowSignInRequest(client: string | null, limits: SignInLimits = { perClient: signInPerClient, perNetwork: signInPerNetwork }): boolean {
  if (!client) return true;
  return limits.perClient.allow(client) && limits.perNetwork.allow(clientNetwork(client));
}

let mailCeiling: RateLimiter | undefined;
/** Every sign-in email the album sends, together, per hour: a guard for the mail provider's quota. */
export function signInMailPerHour(perHour: number): RateLimiter {
  mailCeiling ??= new RateLimiter(perHour, 60 * 60 * 1000);
  return mailCeiling;
}
