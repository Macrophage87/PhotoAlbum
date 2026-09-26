import { describe, expect, it } from "vitest";
import { fallbackActivityType, sportToActivityType } from "@/lib/tracks/sport";

describe("sportToActivityType", () => {
  it("maps common FIT and GPX sport names", () => {
    expect(sportToActivityType("running")).toBe("RUN");
    expect(sportToActivityType("cycling")).toBe("BIKE");
    expect(sportToActivityType("Trail Running")).toBe("RUN");
    expect(sportToActivityType("hiking")).toBe("HIKE");
    expect(sportToActivityType("kayaking")).toBe("KAYAK");
    expect(sportToActivityType("driving")).toBe("DRIVE");
    expect(sportToActivityType("car")).toBe("DRIVE");
    expect(sportToActivityType("train")).toBe("DRIVE");
  });
  it("does not prefix-match unrelated sports as driving", () => {
    expect(sportToActivityType("training")).toBeNull();
    expect(sportToActivityType("transition")).toBeNull();
    expect(sportToActivityType("cardio")).toBeNull();
  });
});

describe("fallbackActivityType", () => {
  it("files a named sport with no type of its own under OTHER instead of guessing from its speed", () => {
    expect(fallbackActivityType("alpine_skiing", 8)).toBe("OTHER");
    expect(fallbackActivityType("swimming", 1)).toBe("OTHER");
    expect(fallbackActivityType("Open Water Swimming", 1)).toBe("OTHER");
  });
  it("guesses from speed only when no sport was named", () => {
    expect(fallbackActivityType(undefined, 8)).toBe("BIKE");
    expect(fallbackActivityType("", 3)).toBe("RUN");
    expect(fallbackActivityType("generic", 8)).toBe("BIKE");
    expect(fallbackActivityType("1", 1)).toBe("HIKE");
  });
  it("maps a few more outdoor FIT sports to their nearest type", () => {
    expect(sportToActivityType("mountaineering")).toBe("HIKE");
    expect(sportToActivityType("rafting")).toBe("KAYAK");
  });
});
