/**
 * Small in-memory throttle for actions that send email. One process per deployment is the
 * normal case for this app, so a Map is enough; it resets on restart, which is acceptable.
 */
type Bucket = { count: number; windowStart: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Returns true when the call is allowed and records it; false when the key is over its limit. */
  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || t - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: t });
      if (this.buckets.size > 10_000) this.prune(t);
      return true;
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (t - b.windowStart >= this.windowMs) this.buckets.delete(k);
  }
}

/** Sign-in links: at most 3 per address and 20 per client address every 10 minutes. */
export const signInPerEmail = new RateLimiter(3, 10 * 60 * 1000);
export const signInPerClient = new RateLimiter(20, 10 * 60 * 1000);
