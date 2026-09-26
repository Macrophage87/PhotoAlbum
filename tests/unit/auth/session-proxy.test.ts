import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const TOKEN = "A".repeat(43);
const appUrl = process.env.APP_URL;

function req(path: string, init: { method?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method ?? "GET", headers });
}

describe("proxy", () => {
  afterEach(() => {
    process.env.APP_URL = appUrl;
  });

  it("carries the session cookie's expiry forward on a page visit, with the same value", () => {
    const res = proxy(req("/trips", { cookie: `session=${TOKEN}` }));
    const set = res.cookies.get("session");
    expect(set?.value).toBe(TOKEN);
    expect(set?.httpOnly).toBe(true);
    expect(set?.sameSite).toBe("lax");
    expect(set?.path).toBe("/");
    // No longer than the database row is sure to last after this page reads it (it slides below 83 days left).
    const expires = new Date(set!.expires as Date).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThan(Date.now() + 82 * day);
    expect(expires).toBeLessThanOrEqual(Date.now() + 83 * day);
  });

  it("leaves the cookie alone on a POST (sign-in or sign-out may be replacing it) and when there is none", () => {
    expect(proxy(req("/auth/signout", { method: "POST", cookie: `session=${TOKEN}` })).cookies.get("session")).toBeUndefined();
    expect(proxy(req("/trips")).cookies.get("session")).toBeUndefined();
    expect(proxy(req("/trips", { cookie: "session=not%20a%20token" })).cookies.get("session")).toBeUndefined();
    expect(proxy(req("/auth/verify?token=x", { cookie: `session=${TOKEN}` })).cookies.get("session")).toBeUndefined();
    expect(proxy(req("/auth/signin", { cookie: `session=${TOKEN}` })).cookies.get("session")).toBeUndefined();
  });

  it("sends HSTS only for an https album", () => {
    process.env.APP_URL = "https://album.example";
    expect(proxy(req("/")).headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(proxy(req("/upload")).headers.get("strict-transport-security")).toMatch(/max-age=/);
    process.env.HSTS_INCLUDE_SUBDOMAINS = "true";
    expect(proxy(req("/")).headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
    process.env.APP_URL = "http://localhost:3200";
    expect(proxy(req("/")).headers.get("strict-transport-security")).toBeNull();
  });
});
