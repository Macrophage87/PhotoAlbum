import { describe, expect, it } from "vitest";
import { RateLimiter } from "@/lib/auth/rate-limit";

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
