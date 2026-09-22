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
    // The plain one only; 'wasm-unsafe-eval' is a different and much narrower permission, covered below.
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toMatch(/img-src [^;]*https:\/\/tiles\.example\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/tiles\.example\.com/);
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
  });
  it("allows plain eval only in development", () => {
    expect(buildCsp({ nonce: "n", dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", dev: false })).not.toContain("'unsafe-eval'");
  });
});

/**
 * What a 3D scan needs. The viewer unpacks the picture baked into a scan by handing itself the bytes as a blob and
 * fetching them back, and decodes a compressed one's geometry in WebAssembly. Neither reaches outside the page, and
 * without both a scan is drawn plain white or not at all.
 */
describe("what the 3D viewer needs of the policy", () => {
  const csp = buildCsp({ nonce: "abc", dev: false });

  it("lets the page fetch its own blobs, so a scan keeps its colors", () => {
    expect(csp).toMatch(/connect-src [^;]*\bblob:/);
  });

  it("lets WebAssembly compile, without letting anything call eval", () => {
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval' "); // the plain one stays out of a production policy
    expect(buildCsp({ nonce: "abc", dev: false }).includes("'unsafe-eval'")).toBe(false);
  });
})
