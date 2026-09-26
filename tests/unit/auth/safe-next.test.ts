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
  it("rejects what the URL parser would turn into another host (tabs, newlines, dot segments)", () => {
    // The parser drops tabs and newlines, so "/\t/evil" is "//evil" by the time a browser follows it.
    expect(safeNextPath("/\t/evil.example.com")).toBe("/");
    expect(safeNextPath("/\n/evil.example.com")).toBe("/");
    expect(safeNextPath("/\t\\evil.example.com")).toBe("/");
    expect(safeNextPath("/\u0000x")).toBe("/");
    expect(safeNextPath("/..//evil.example.com")).toBe("/");
    expect(safeNextPath("/a/..//evil.example.com")).toBe("/");
    expect(safeNextPath("/./\\evil.example.com")).toBe("/");
    // An escaped tab is just part of a path on this site.
    expect(safeNextPath("/%09/evil.example.com")).toBe("/%09/evil.example.com");
    expect(new URL(safeNextPath("/%09/evil.example.com"), "https://album.example").host).toBe("album.example");
  });
});
