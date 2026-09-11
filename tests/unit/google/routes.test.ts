import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  process.env.APP_URL = "https://album.example";
});
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (arg: string | { name: string }) => { jar.delete(typeof arg === "string" ? arg : arg.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));
const viewer = vi.hoisted(() => ({ kind: "user" as "user" | "anonymous", user: { id: "u1", email: "u@example.com", name: null, role: "MEMBER" } }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => (viewer.kind === "user" ? viewer : { kind: "anonymous", user: null, shareTokens: new Map() }) }));
const oauth = vi.hoisted(() => ({ exchange: vi.fn(), stored: [] as string[] }));
vi.mock("@/lib/google/oauth", async (orig) => ({ ...(await orig()) as object, exchangeCode: oauth.exchange }));
vi.mock("@/lib/google/account", () => ({ storeRefreshToken: async (_u: string, t: string) => { oauth.stored.push(t); } }));

import { GET as connect } from "@/app/api/google/connect/route";
import { GET as callback } from "@/app/api/google/callback/route";
import { PICKER_SCOPE } from "@/lib/google/oauth";

const location = (r: Response) => r.headers.get("location") ?? "";

describe("the Google connect and callback routes", () => {
  beforeEach(() => { jar.clear(); oauth.exchange.mockReset(); oauth.stored.length = 0; viewer.kind = "user"; });

  it("sends a member to Google with a fresh state and keeps only a same-site return path", async () => {
    const r = await connect(new Request("https://album.example/api/google/connect?next=/review"));
    expect(r.status).toBe(303);
    const u = new URL(location(r));
    expect(u.searchParams.get("scope")).toBe(PICKER_SCOPE);
    const [state, next] = jar.get("google_oauth_state")!.split(":");
    expect(u.searchParams.get("state")).toBe(state);
    expect(next).toBe("/review");
  });
  it.each(["//evil.example", "/\\evil.example", "https://evil.example/x", "evil"])("refuses an off-site return path %s", async (bad) => {
    await connect(new Request(`https://album.example/api/google/connect?next=${encodeURIComponent(bad)}`));
    expect(jar.get("google_oauth_state")!.split(":")[1]).toBe("/upload");
  });
  it("requires a signed-in member", async () => {
    viewer.kind = "anonymous";
    expect(location(await connect(new Request("https://album.example/api/google/connect")))).toContain("/auth/signin");
    expect(location(await callback(new Request("https://album.example/api/google/callback?code=x&state=y")))).toContain("/auth/signin");
  });

  async function primed(next = "/upload") {
    jar.set("google_oauth_state", `st4te:${next}`);
  }
  it("stores the refresh token and returns to the saved path on a good callback", async () => {
    await primed("/review");
    oauth.exchange.mockResolvedValue({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: PICKER_SCOPE });
    const r = await callback(new Request("https://album.example/api/google/callback?code=abc&state=st4te"));
    expect(location(r)).toBe("https://album.example/review?google=connected");
    expect(oauth.exchange).toHaveBeenCalledWith("abc");
    expect(oauth.stored).toEqual(["r"]);
    expect(jar.has("google_oauth_state")).toBe(false);
  });
  it("rejects a callback whose state does not match the cookie, and one with no cookie at all", async () => {
    await primed();
    expect(location(await callback(new Request("https://album.example/api/google/callback?code=abc&state=other")))).toBe("https://album.example/upload?google=state");
    expect(oauth.exchange).not.toHaveBeenCalled();
    expect(location(await callback(new Request("https://album.example/api/google/callback?code=abc&state=st4te")))).toBe("https://album.example/upload?google=state");
  });
  it("reports a declined consent screen and a missing code without exchanging anything", async () => {
    await primed();
    expect(location(await callback(new Request("https://album.example/api/google/callback?error=access_denied&state=st4te")))).toContain("google=denied");
    await primed();
    expect(location(await callback(new Request("https://album.example/api/google/callback?state=st4te")))).toContain("google=denied");
    expect(oauth.exchange).not.toHaveBeenCalled();
  });
  it("refuses a grant without the picker scope and reports a failed exchange", async () => {
    await primed();
    oauth.exchange.mockResolvedValue({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "openid email" });
    expect(location(await callback(new Request("https://album.example/api/google/callback?code=abc&state=st4te")))).toContain("google=scope");
    expect(oauth.stored).toEqual([]);
    await primed();
    oauth.exchange.mockRejectedValue(new Error("boom"));
    expect(location(await callback(new Request("https://album.example/api/google/callback?code=abc&state=st4te")))).toContain("google=failed");
  });
  it("never redirects off-site even if the cookie was tampered with", async () => {
    jar.set("google_oauth_state", "st4te:/\\evil.example");
    expect(location(await callback(new Request("https://album.example/api/google/callback?error=x&state=st4te")))).toBe("https://album.example/upload?google=denied");
  });
});
