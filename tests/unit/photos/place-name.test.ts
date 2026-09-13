import { describe, expect, it } from "vitest";
import { placeNameOf } from "@/lib/geo/parse";

describe("the name a member picked", () => {
  it("is kept as it was shown to them, and a blank one is no name at all", () => {
    expect(placeNameOf("Jordan Pond, Mount Desert Island, Maine")).toBe("Jordan Pond, Mount Desert Island, Maine");
    expect(placeNameOf("  Rome, Italy  ")).toBe("Rome, Italy");
    expect(placeNameOf("")).toBeNull();
    expect(placeNameOf("   ")).toBeNull();
    expect(placeNameOf(null)).toBeNull();
  });
  it("is capped rather than refused, so a very long label still saves the place", () => {
    expect(placeNameOf("x".repeat(400))).toHaveLength(200);
  });
});
