import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/tokens";

describe("safeNextPath", () => {
  it("accepts same-site relative paths", () => {
    expect(safeNextPath("/trips/maine")).toBe("/trips/maine");
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/a?b=c#d")).toBe("/a?b=c#d");
  });
  it("rejects protocol-relative, absolute and malformed targets", () => {
    expect(safeNextPath("//evil.example.com")).toBe("/");
    expect(safeNextPath("/\\evil.example.com")).toBe("/");
    expect(safeNextPath("https://evil.example.com")).toBe("/");
    expect(safeNextPath("trips")).toBe("/");
    expect(safeNextPath("/x\r\nSet-Cookie: a=b")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null, "")).toBe("");
  });
});
