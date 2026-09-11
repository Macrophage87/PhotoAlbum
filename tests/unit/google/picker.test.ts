import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.GOOGLE_PHOTOS_API_URL = "https://picker.test/v1";
  process.env.GOOGLE_OAUTH_BASE_URL = "https://oauth.test/base";
  process.env.GOOGLE_ACCOUNTS_URL = "https://accounts.test/acc/";
  process.env.APP_URL = "https://album.example";
});

import { authorizationUrl, exchangeCode, GoogleAuthError, refreshAccessToken } from "@/lib/google/oauth";
import { createPickerSession, downloadUrl, listPickedItems, parseDuration } from "@/lib/google/picker";

const calls: { url: string; init?: RequestInit }[] = [];
let responses: (() => Response)[] = [];
beforeEach(() => {
  calls.length = 0;
  responses = [];
  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
});
afterEach(() => vi.unstubAllGlobals());
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("oauth", () => {
  it("asks for offline access with a forced consent screen and the picker scope only", () => {
    const u = new URL(authorizationUrl("st4te"));
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.test/acc/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/photospicker.mediaitems.readonly");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(u.searchParams.get("redirect_uri")).toBe("https://album.example/api/google/callback");
  });
  it("exchanges a code and refuses a reply without a refresh token", async () => {
    responses = [json(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }), json(200, { access_token: "a", expires_in: 3600 })];
    expect(await exchangeCode("c")).toMatchObject({ accessToken: "a", refreshToken: "r" });
    expect(String(calls[0].init?.body)).toContain("grant_type=authorization_code");
    expect(calls[0].url).toBe("https://oauth.test/base/token");
    await expect(exchangeCode("c")).rejects.toBeInstanceOf(GoogleAuthError);
  });
  it("flags invalid_grant on refresh as needing a reconnect", async () => {
    responses = [json(400, { error: "invalid_grant", error_description: "revoked" })];
    await expect(refreshAccessToken("r")).rejects.toMatchObject({ needsReconnect: true });
  });
});

describe("picker sessions", () => {
  it("parses durations", () => {
    expect(parseDuration("5s", 1)).toBe(5000);
    expect(parseDuration("2.5s", 1)).toBe(2500);
    expect(parseDuration(undefined, 7)).toBe(7);
  });
  it("creates a session with the bearer token and pages through picked items", async () => {
    responses = [
      json(200, { id: "s1", pickerUri: "https://photos.google.com/picker/s1", pollingConfig: { pollInterval: "3s" } }),
      json(200, { mediaItems: [{ id: "a", type: "PHOTO", mediaFile: { baseUrl: "https://lh3/a", mimeType: "image/jpeg", filename: "a.jpg" } }], nextPageToken: "p2" }),
      json(200, { mediaItems: [{ id: "b", type: "VIDEO", mediaFile: { baseUrl: "https://lh3/b", mimeType: "video/mp4", filename: "b.mp4" } }, { id: "c" }] }),
    ];
    const s = await createPickerSession("tok");
    expect(s).toMatchObject({ id: "s1", mediaItemsSet: false, pollIntervalMs: 3000 });
    expect(calls[0].url).toBe("https://picker.test/v1/sessions");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const items = await listPickedItems("tok", "s1");
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(calls[2].url).toContain("pageToken=p2");
    expect(downloadUrl(items[0])).toBe("https://lh3/a=d");
    expect(downloadUrl(items[1])).toBe("https://lh3/b=dv");
  });
  it("turns a 401 into a reconnect error", async () => {
    responses = [json(401, {})];
    await expect(createPickerSession("stale")).rejects.toMatchObject({ needsReconnect: true });
  });
});
