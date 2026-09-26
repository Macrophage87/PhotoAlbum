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
  const limits = (now = () => 0) => ({
    perClient: new RateLimiter(20, 1000, now),
    perEmailClient: new RateLimiter(3, 1000, now),
  });

  it("does not let other clients use up a member's own allowance, however many there are", () => {
    const l = limits();
    // One attacker spends its whole client allowance on grandma, and a crowd of others three each.
    for (let i = 0; i < 20; i++) allowSignInRequest("grandma@example.com", "203.0.113.66", l);
    for (let c = 0; c < 50; c++) for (let i = 0; i < 3; i++) expect(allowSignInRequest("grandma@example.com", `192.0.2.${c}`, l)).toBe(true);
    expect(allowSignInRequest("grandma@example.com", "192.0.2.0", l)).toBe(false);
    // Grandma, from her own address, still gets her link.
    expect(allowSignInRequest("grandma@example.com", "198.51.100.7", l)).toBe(true);
  });

  it("checks the client first, so requests refused for the client charge nobody's address", () => {
    // The address allowance outlives the client's window: were the address charged first, the refused requests
    // below would have used it up by the time the client may ask again.
    let now = 0;
    const l = { perClient: new RateLimiter(20, 1000, () => now), perEmailClient: new RateLimiter(3, 10_000, () => now) };
    for (let i = 0; i < 20; i++) expect(allowSignInRequest(`x${i}@example.com`, "203.0.113.66", l)).toBe(true);
    for (let i = 0; i < 5; i++) expect(allowSignInRequest("grandma@example.com", "203.0.113.66", l)).toBe(false);
    now = 1000;
    for (let i = 0; i < 3; i++) expect(allowSignInRequest("grandma@example.com", "203.0.113.66", l)).toBe(true);
  });

  it("caps one address per client, and per request when there is no proxy", () => {
    const l = limits();
    for (let i = 0; i < 3; i++) expect(allowSignInRequest("a@example.com", "203.0.113.1", l)).toBe(true);
    expect(allowSignInRequest("a@example.com", "203.0.113.1", l)).toBe(false);
    const bare = limits();
    for (let i = 0; i < 3; i++) expect(allowSignInRequest("a@example.com", null, bare)).toBe(true);
    expect(allowSignInRequest("a@example.com", null, bare)).toBe(false);
  });
});
