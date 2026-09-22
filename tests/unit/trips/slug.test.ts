import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "@/lib/trips/slug";

describe("slugify", () => {
  it("normalizes titles", () => {
    expect(slugify("Acadia, Maine!")).toBe("acadia-maine");
    expect(slugify("  Île de Ré — été 2025 ")).toBe("ile-de-re-ete-2025");
    expect(slugify("!!!")).toBe("trip");
  });
});

describe("uniqueSlug", () => {
  it("adds a numeric suffix on collision", async () => {
    const taken = new Set(["maine", "maine-2"]);
    expect(await uniqueSlug("Maine", async (s) => taken.has(s))).toBe("maine-3");
    expect(await uniqueSlug("Scotland", async (s) => taken.has(s))).toBe("scotland");
  });
});
