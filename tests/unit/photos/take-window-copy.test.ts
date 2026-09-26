import { describe, expect, it } from "vitest";
import { leftAlone } from "@/components/photos/TakeWindow";

describe("what the 'add all' box says it left alone", () => {
  it("says nothing when nothing was left", () => {
    expect(leftAlone("activity", 0)).toBe("");
  });
  it("tells a trip page they are on another trip", () => {
    expect(leftAlone("trip", 1)).toBe("1 more from that time was already on another trip, so it was left alone. Search by date below to add it.");
  });
  it("tells an activity page a family member put them somewhere, without calling a kept-off photo another activity", () => {
    const s = leftAlone("activity", 3);
    expect(s).toContain("3 more from that time were already put somewhere by a family member");
    expect(s).toContain("kept off activities");
    expect(s).toContain("so they were left alone. Search by date below to add any of them.");
  });
});
