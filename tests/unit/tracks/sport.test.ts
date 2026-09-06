import { describe, expect, it } from "vitest";
import { sportToActivityType } from "@/lib/tracks/sport";

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
