import { describe, expect, it, vi } from "vitest";
import { clientKey, clientNetwork, forwardedClient, warnOnceIfNoClient } from "@/lib/auth/client-address";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { hstsIncludesSubdomains, hstsValue } from "@/lib/security/hsts";

describe("forwardedClient", () => {
  it("trusts only the entry our proxy appended, never the ones the requester wrote", () => {
    expect(forwardedClient(new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(forwardedClient(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(forwardedClient(new Headers({ "x-forwarded-for": " , " , "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(forwardedClient(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(forwardedClient(new Headers())).toBeNull();
    // A trailing comma or blank entry is not an address; the last real one is.
    expect(forwardedClient(new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7," }))).toBe("198.51.100.7");
    expect(forwardedClient(new Headers({ "x-forwarded-for": "1.2.3.4, [2001:db8:1:2::9]:443" }))).toBe("2001:db8:1:2::/64");
  });

  it("keys an IPv6 client by its /64, since it can pick any address inside it", () => {
    expect(clientKey("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientKey("[2001:db8:1:2:3::4]:443")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:3::5")).not.toBe(clientKey("2001:db8:1:2::5"));
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("keys an IPv4 client by its address, without a port, mapped or not", () => {
    expect(clientKey("198.51.100.7")).toBe("198.51.100.7");
    expect(clientKey("198.51.100.7:51234")).toBe("198.51.100.7");
    expect(clientKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  it("keys an IPv6 address that only carries an IPv4 one by that IPv4 address", () => {
    expect(clientKey("::ffff:c633:6407")).toBe("198.51.100.7"); // mapped, in hex
    expect(clientKey("::ffff:0:198.51.100.7")).toBe("198.51.100.7"); // translated
    expect(clientKey("64:ff9b::198.51.100.7")).toBe("198.51.100.7"); // NAT64
    expect(clientKey("64:ff9b::c633:6407")).toBe("198.51.100.7");
    expect(clientKey("[::ffff:198.51.100.7]:443")).toBe("198.51.100.7");
  });

  it("widens an IPv6 /64 to its /48, and leaves an IPv4 address as it is", () => {
    expect(clientNetwork(clientKey("2001:db8:1:2::5"))).toBe("2001:db8:1::/48");
    expect(clientNetwork("198.51.100.7")).toBe("198.51.100.7");
  });
});

describe("warnOnceIfNoClient", () => {
  it("warns once in production when no proxy names the client, and never otherwise", () => {
    const log = vi.fn();
    warnOnceIfNoClient(null, log); // the test environment is not production
    vi.stubEnv("NODE_ENV", "production");
    try {
      warnOnceIfNoClient("198.51.100.7", log);
      expect(log).not.toHaveBeenCalled();
      warnOnceIfNoClient(null, log);
      warnOnceIfNoClient(null, log);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/X-Forwarded-For/);
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(hstsValue("https://album.example")).toBe("max-age=31536000");
    expect(hstsValue("https://album.example", true)).toBe("max-age=31536000; includeSubDomains");
    expect(hstsValue("http://localhost:3200")).toBeNull();
    expect(hstsValue(undefined)).toBeNull();
    expect(hstsValue("not a url")).toBeNull();
  });
  it("covers subdomains only when HSTS_INCLUDE_SUBDOMAINS asks", () => {
    expect(hstsIncludesSubdomains("true")).toBe(true);
    expect(hstsIncludesSubdomains("1")).toBe(true);
    expect(hstsIncludesSubdomains("yes")).toBe(true);
    expect(hstsIncludesSubdomains("On")).toBe(true);
    expect(hstsIncludesSubdomains("false")).toBe(false);
    expect(hstsIncludesSubdomains(undefined)).toBe(false);
  });
});
