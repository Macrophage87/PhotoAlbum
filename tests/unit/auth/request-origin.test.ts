import { describe, expect, it } from "vitest";
import { forwardedClient } from "@/lib/auth/client-address";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { hstsValue } from "@/lib/security/hsts";

describe("forwardedClient", () => {
  it("trusts only the entry our proxy appended, never the ones the requester wrote", () => {
    expect(forwardedClient(new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(forwardedClient(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(forwardedClient(new Headers({ "x-forwarded-for": " , " , "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(forwardedClient(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(forwardedClient(new Headers())).toBeNull();
  });
});

describe("isSameOriginRequest", () => {
  const app = "https://album.example";
  it("accepts the album's own pages", () => {
    expect(isSameOriginRequest(new Headers({ "sec-fetch-site": "same-origin", origin: app }), app)).toBe(true);
    expect(isSameOriginRequest(new Headers({ origin: app }), app)).toBe(true);
    expect(isSameOriginRequest(new Headers({ origin: "http://192.168.1.5:3000", host: "192.168.1.5:3000" }), app)).toBe(true);
    expect(isSameOriginRequest(new Headers(), app)).toBe(true);
  });
  it("refuses another site's form, even a sibling subdomain", () => {
    expect(isSameOriginRequest(new Headers({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), app)).toBe(false);
    expect(isSameOriginRequest(new Headers({ "sec-fetch-site": "same-site", origin: "https://blog.album.example" }), app)).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: "https://evil.example", host: "album.example" }), app)).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: "null" }), app)).toBe(false);
  });
});

describe("hstsValue", () => {
  it("is sent only for an https album", () => {
    expect(hstsValue("https://album.example")).toMatch(/^max-age=\d+; includeSubDomains$/);
    expect(hstsValue("http://localhost:3200")).toBeNull();
    expect(hstsValue(undefined)).toBeNull();
    expect(hstsValue("not a url")).toBeNull();
  });
});
