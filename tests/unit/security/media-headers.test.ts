import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { MEDIA_CSP } from "@/lib/security/csp";

describe("media response headers", () => {
  it("next.config gives /api/photos/* the media policy, and the catch-all policy leaves that path alone", async () => {
    const rules = await nextConfig.headers!();
    const media = rules.find((r) => r.source === "/api/photos/:path*");
    expect(media?.headers).toContainEqual({ key: "Content-Security-Policy", value: MEDIA_CSP });
    expect(MEDIA_CSP).toContain("sandbox");
    const framePolicy = rules.find((r) => r.headers.some((h) => h.key === "Content-Security-Policy" && h.value.includes("youtube")));
    const pattern = new RegExp(`^${framePolicy!.source.replace(/^\//, "\\/")}$`);
    expect(pattern.test("/api/photos/abc/original")).toBe(false);
    expect(pattern.test("/trips/x")).toBe(true);
    // nosniff on everything.
    expect(rules.find((r) => r.source === "/:path*")?.headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
  });
});
