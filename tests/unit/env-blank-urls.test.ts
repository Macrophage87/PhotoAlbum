import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** .env.example ships the optional endpoints as `NAME=` (blank). A blank
 *  value must read as "unset" (or the default), not fail the URL check —
 *  otherwise a stock install refuses to start. */
async function loadEnv(overrides: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  const mod = await import("@/lib/env");
  return mod.env();
}

const BLANK = {
  DATABASE_URL: "postgresql://x:y@localhost:5432/z",
  APP_URL: "",
  YOUTUBE_OEMBED_URL: "",
  YOUTUBE_THUMBNAIL_URL: "",
  YOUTUBE_DATA_API_URL: "",
  ANTHROPIC_BASE_URL: "",
  ML_URL: "",
  ML_TOKEN: "",
  GOOGLE_ACCOUNTS_URL: "",
  GOOGLE_OAUTH_BASE_URL: "",
  GOOGLE_PHOTOS_API_URL: "",
};

describe("blank URL variables", () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of Object.keys(BLANK)) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it("treats a blank optional URL as unset and a blank defaulted URL as its default", async () => {
    const e = await loadEnv(BLANK);
    expect(e.ML_URL).toBeUndefined();
    expect(e.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(e.APP_URL).toBe("http://localhost:3000");
    expect(e.YOUTUBE_OEMBED_URL).toBe("https://www.youtube.com/oembed");
    expect(e.YOUTUBE_THUMBNAIL_URL).toBe("https://i.ytimg.com/vi");
    expect(e.YOUTUBE_DATA_API_URL).toBe("https://www.googleapis.com/youtube/v3");
    expect(e.GOOGLE_ACCOUNTS_URL).toBe("https://accounts.google.com");
  });

  it("still validates a non-blank value and the ML_URL/ML_TOKEN pairing", async () => {
    await expect(loadEnv({ ...BLANK, ML_URL: "not a url" })).rejects.toThrow(/ML_URL/);
    await expect(loadEnv({ ...BLANK, ML_URL: "http://ml:8000" })).rejects.toThrow(/ML_TOKEN/);
    const e = await loadEnv({ ...BLANK, ML_URL: "http://ml:8000", ML_TOKEN: "t" });
    expect(e.ML_URL).toBe("http://ml:8000");
  });
});
