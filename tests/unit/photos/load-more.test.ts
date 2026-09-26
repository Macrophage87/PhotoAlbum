import { describe, expect, it } from "vitest";
import { mergePages } from "@/components/photos/LoadMore";
import type { GridPhoto } from "@/components/photos/PhotoGrid";

const photo = (id: string, mediumUrl = `/m/${id}`) => ({ id, mediumUrl, width: 1, height: 1, caption: null, alt: id }) as GridPhoto;

describe("a gallery's pages (#111)", () => {
  it("shows the first page as the server last sent it, so a refresh after an action is seen", () => {
    const fetched = [photo("c"), photo("d")];
    const before = mergePages([photo("a"), photo("b")], fetched);
    expect(before.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    // Auto color gave "b" a new thumbnail; the refreshed first page carries it.
    const after = mergePages([photo("a"), photo("b", "/m/b?v=2")], fetched);
    expect(after.find((p) => p.id === "b")?.mediumUrl).toBe("/m/b?v=2");
  });

  it("keeps the order the server now gives, and never shows one photo twice when it moves between pages", () => {
    // A heart moved "d" up into the first page.
    const merged = mergePages([photo("d"), photo("a")], [photo("b"), photo("d")]);
    expect(merged.map((p) => p.id)).toEqual(["d", "a", "b"]);
  });
});
