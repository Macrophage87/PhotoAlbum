import { describe, expect, it } from "vitest";
import { buildCsp, originOf } from "@/lib/security/csp";

describe("content security policy", () => {
  it("derives hosts from templated tile and glyph URLs", () => {
    expect(originOf("https://tiles.example.com/{z}/{x}/{y}.png?key=abc")).toBe("https://tiles.example.com");
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
  it("nonces scripts, allows inline styles, workers and the map hosts, and never eval in production", () => {
    const csp = buildCsp({ nonce: "abc", dev: false, tileUrl: "https://tiles.example.com/{z}/{x}/{y}.png" });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toMatch(/img-src [^;]*https:\/\/tiles\.example\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/tiles\.example\.com/);
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
  });
  it("allows eval only in development", () => {
    expect(buildCsp({ nonce: "n", dev: true })).toContain("'unsafe-eval'");
  });
});
