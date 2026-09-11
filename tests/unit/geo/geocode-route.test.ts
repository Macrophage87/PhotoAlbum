import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.GEOCODER_URL = "https://geo.test/search"; process.env.APP_URL = "https://album.example"; });
const viewer = vi.hoisted(() => ({ kind: "user" as "user" | "anonymous" }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => (viewer.kind === "user" ? { kind: "user", user: { id: "u" } } : { kind: "anonymous", user: null }) }));

import { GET } from "@/app/api/geocode/route";

const calls: string[] = [];
beforeEach(() => { calls.length = 0; viewer.kind = "user"; });
afterEach(() => vi.unstubAllGlobals());

describe("the address lookup proxy", () => {
  it("forwards only the typed words, identifies the album, and returns trimmed hits", async () => {
    vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)["user-agent"]).toContain("album.example");
      return new Response(JSON.stringify([{ display_name: "Jordan Pond, Maine", lat: "44.326", lon: "-68.253" }, { display_name: "bad", lat: "x", lon: "y" }]), { status: 200 });
    });
    const r = await GET(new Request("https://album.example/api/geocode?q=Jordan%20Pond"));
    expect(await r.json()).toEqual({ hits: [{ label: "Jordan Pond, Maine", lat: 44.326, lng: -68.253 }] });
    const sent = new URL(calls[0]);
    expect(sent.origin + sent.pathname).toBe("https://geo.test/search");
    expect(sent.searchParams.get("q")).toBe("Jordan Pond");
    expect([...sent.searchParams.keys()].sort()).toEqual(["addressdetails", "format", "limit", "q"]);
  });
  it("refuses anonymous callers and short queries without contacting anyone", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("must not be called"); });
    viewer.kind = "anonymous";
    expect((await GET(new Request("https://album.example/api/geocode?q=Jordan"))).status).toBe(401);
    viewer.kind = "user";
    expect(await (await GET(new Request("https://album.example/api/geocode?q=J"))).json()).toEqual({ hits: [] });
  });
  it("turns a lookup failure into an empty answer with a 502", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    const r = await GET(new Request("https://album.example/api/geocode?q=Jordan%20Pond"));
    expect(r.status).toBe(502);
  });
});
