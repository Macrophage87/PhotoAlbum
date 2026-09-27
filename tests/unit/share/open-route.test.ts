import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ set: [] as { name: string; value: string; opts: Record<string, unknown> }[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string, opts: Record<string, unknown>) => void jar.set.push({ name, value, opts }) }) }));
vi.mock("@/lib/share/queries", () => ({
  getSharedTrip: async (t: string) => (t === "good" ? { id: "trip1" } : null),
  getSharedCollection: async () => null,
  getSharedActivity: async () => null,
}));

import { POST } from "@/app/api/share/open/route";
import { SHARE_OPENED_COOKIE } from "@/lib/share/opened-cookie";

const open = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/share/open", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) }));

describe("opening a share link", () => {
  beforeEach(() => void (jar.set = []));

  it("keeps the token for that trip, and a readable cookie beside it that the page can check it by", async () => {
    expect((await open({ kind: "trip", id: "trip1", token: "good" })).status).toBe(204);
    expect(jar.set.map((c) => [c.name, c.value, c.opts.httpOnly])).toEqual([["share_trip_trip1", "good", true], [SHARE_OPENED_COOKIE, "trip1", false]]);
    // The same attributes on both, so the browser keeps both or neither.
    expect(jar.set[0].opts.secure).toBe(jar.set[1].opts.secure);
    expect(jar.set[0].opts.sameSite).toBe(jar.set[1].opts.sameSite);
  });

  it("sets nothing for a token that is not this trip's, or one that is not a token at all", async () => {
    expect((await open({ kind: "trip", id: "other", token: "good" })).status).toBe(404);
    expect((await open({ kind: "trip", id: "trip1", token: "bad" })).status).toBe(404);
    expect((await open({ kind: "album", id: "trip1", token: "good" })).status).toBe(400);
    expect(jar.set).toEqual([]);
  });

  it("refuses a request from another site, so a page elsewhere cannot plant a share cookie", async () => {
    expect((await open({ kind: "trip", id: "trip1", token: "good" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await open({ kind: "trip", id: "trip1", token: "good" }, { "sec-fetch-site": "", origin: "https://evil.example" })).status).toBe(403);
    expect(jar.set).toEqual([]);
  });

  it("refuses a body that is not JSON, which is all a plain form can send", async () => {
    expect((await open({ kind: "trip", id: "trip1", token: "good" }, { "content-type": "text/plain" })).status).toBe(415);
    expect(jar.set).toEqual([]);
  });
});
