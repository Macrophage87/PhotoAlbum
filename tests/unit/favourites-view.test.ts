import { describe, expect, it } from "vitest";
import { parseWho } from "@/components/favourites/FavouritesView";

describe("whose favorites a page shows", () => {
  it("is this member's own unless the family's are asked for by name", () => {
    expect(parseWho(undefined)).toBe("mine");
    expect(parseWho("mine")).toBe("mine");
    expect(parseWho("family")).toBe("family");
  });

  it("treats anything else in the address as mine rather than failing", () => {
    // A hand-typed or mangled address still lands somewhere sensible.
    expect(parseWho("everyone")).toBe("mine");
    expect(parseWho(["family", "mine"])).toBe("mine");
  });
});
