import { describe, expect, it } from "vitest";
import { allowSignInRequest, RateLimiter } from "@/lib/auth/rate-limit";

describe("RateLimiter", () => {
  it("allows up to max calls per window and resets afterwards", () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
    now = 1000;
    expect(rl.allow("a")).toBe(true);
  });
});

describe("RateLimiter capacity", () => {
  it("stays bounded under a flood of new keys by dropping the oldest buckets", () => {
    let now = 0;
    const rl = new RateLimiter(1, 1000, () => now, 100);
    for (let i = 0; i < 1000; i++) expect(rl.allow(`k${i}`)).toBe(true);
    expect(rl.size).toBe(100);
    // The newest keys are the ones still limited.
    expect(rl.allow("k999")).toBe(false);
    now = 2000;
    rl.allow("fresh");
    expect(rl.size).toBe(1);
  });

  it("keeps a renewed bucket at the back, so expired ones ahead of it are dropped", () => {
    let now = 0;
    const rl = new RateLimiter(1, 1000, () => now, 100);
    rl.allow("a");
    now = 500;
    rl.allow("b");
    now = 1200;
    rl.allow("a"); // a new window for "a"; "b" is still live and "a" is re-queued behind it
    expect(rl.size).toBe(2);
    now = 1600;
    rl.allow("c"); // "b" has expired and goes; "a" stays
    expect(rl.size).toBe(2);
    expect(rl.allow("a")).toBe(false);
  });
});

describe("allowSignInRequest", () => {
  const limits = () => ({ perClient: new RateLimiter(20, 1000, () => 0), perNetwork: new RateLimiter(60, 1000, () => 0), unknown: new RateLimiter(30, 1000, () => 0) });

  it("caps each client, and each IPv6 /48 however many /64s it spreads over", () => {
    const l = limits();
    for (let i = 0; i < 20; i++) expect(allowSignInRequest("203.0.113.66", l)).toBe(true);
    expect(allowSignInRequest("203.0.113.66", l)).toBe(false);
    let allowed = 0;
    for (let i = 0; i < 500; i++) if (allowSignInRequest(`2001:db8:1:${i.toString(16)}::/64`, l)) allowed++;
    expect(allowed).toBe(60);
    // A neighbouring /48 is somebody else.
    expect(allowSignInRequest("2001:db8:2:1::/64", l)).toBe(true);
  });

  it("puts every request that no proxy vouches for into one shared bucket", () => {
    const l = limits();
    for (let i = 0; i < 30; i++) expect(allowSignInRequest(null, l)).toBe(true);
    expect(allowSignInRequest(null, l)).toBe(false);
    // Clients a proxy names are unaffected.
    expect(allowSignInRequest("198.51.100.7", l)).toBe(true);
  });

  it("peeks without charging", () => {
    const rl = new RateLimiter(1, 1000, () => 0);
    expect(rl.hasRoom("all")).toBe(true);
    expect(rl.hasRoom("all")).toBe(true);
    expect(rl.allow("all")).toBe(true);
    expect(rl.hasRoom("all")).toBe(false);
    rl.refund("all");
    expect(rl.allow("all")).toBe(true);
  });
});
