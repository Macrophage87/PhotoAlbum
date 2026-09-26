import { describe, expect, it } from "vitest";
import { leftFor, searchKey } from "@/components/containers/ContainerPicker";

describe("the trip and collection picker (#129)", () => {
  it("tells the results for what was just typed from the ones for what was there before", () => {
    expect(searchKey("trip", "Ital")).not.toBe(searchKey("trip", ""));
    expect(searchKey("trip", "Ital")).not.toBe(searchKey("collection", "Ital"));
    expect(searchKey("activity", "walk", "t1")).not.toBe(searchKey("activity", "walk", "t2"));
    expect(searchKey("trip", "Ital")).toBe(searchKey("trip", "Ital"));
  });

  it("closes its list when focus leaves the picker, and not when it moves within it", () => {
    const inside = {} as Node, outside = {} as Node;
    const box = { contains: (n: Node | null) => n === inside };
    expect(leftFor(box, outside)).toBe(true);
    expect(leftFor(box, null)).toBe(true);
    expect(leftFor(box, inside as EventTarget)).toBe(false);
  });
});
