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
 * Sign-in links. Per client address: 20 every 10 minutes. Per address asked for: 3 from any one client, and 10 in
 * all, so somebody else asking for grandma's link cannot use up her own allowance.
 */
export const signInPerClient = new RateLimiter(20, 10 * 60 * 1000);
export const signInPerEmailClient = new RateLimiter(3, 10 * 60 * 1000);
export const signInPerEmail = new RateLimiter(10, 10 * 60 * 1000);

export type SignInLimits = { perClient: RateLimiter; perEmailClient: RateLimiter; perEmail: RateLimiter };

/**
 * Whether one more sign-in link may go out. The client is checked first, so a requester already over its own cap
 * cannot use up anybody's address; the address then has an allowance per client, so one requester cannot exhaust
 * it for everyone else. The per-client cap is best-effort: it only applies when a proxy supplies a client address,
 * so that an install without a proxy does not put every visitor in one shared bucket.
 */
export function allowSignInRequest(
  email: string,
  client: string | null,
  limits: SignInLimits = { perClient: signInPerClient, perEmailClient: signInPerEmailClient, perEmail: signInPerEmail },
): boolean {
  if (client && !limits.perClient.allow(client)) return false;
  return limits.perEmailClient.allow(`${email}\n${client ?? ""}`) && limits.perEmail.allow(email);
}
