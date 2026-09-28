import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => ({ kind: "user", user: { id: "u", email: "u@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() }) }));

import { decodeHeaderName } from "@/lib/media/header-name";
import { POST } from "@/app/api/upload/route";

describe("a file name sent in a header", () => {
  it("decodes what the browser encoded, and turns a malformed one into null", () => {
    expect(decodeHeaderName(encodeURIComponent("Jo's walk.gpx"))).toBe("Jo's walk.gpx");
    expect(decodeHeaderName(null)).toBe("");
    expect(decodeHeaderName("%E0.jpg")).toBeNull();
  });

  it("is a bad request on upload, not a crash", async () => {
    const res = await POST(new Request("https://album.example/api/upload", { method: "POST", body: "x", headers: { "x-file-name": "%E0.jpg", "content-type": "image/jpeg" } }));
    expect(res.status).toBe(400);
  });
});
