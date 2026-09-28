import { describe, expect, it } from "vitest";
import { enterChoice, leftFor, searchKey } from "@/components/containers/ContainerPicker";

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

  it("carries out Enter on No trip or an extra choice at once, even while the results are loading", () => {
    // Two results from the last answer, then "Photos without a trip" and "No trip"; the next answer is on its way.
    const loading = { hits: 2, tail: 2, fresh: false, byKeys: true };
    expect(enterChoice({ ...loading, active: 2 })).toEqual({ pick: "tail", index: 0 });
    expect(enterChoice({ ...loading, active: 3 })).toEqual({ pick: "tail", index: 1 });
    // On a result, it waits for the answer to what was typed, as before.
    expect(enterChoice({ ...loading, active: 1 })).toEqual({ pick: "wait" });
    // Typed and Enter at once, with nothing in the last answer: "No trip" is first only by accident, so it waits.
    expect(enterChoice({ active: 0, hits: 0, tail: 1, fresh: false, byKeys: false })).toEqual({ pick: "wait" });
  });

  it("carries out Enter on whatever is active once the results are in", () => {
    expect(enterChoice({ active: 1, hits: 2, tail: 1, fresh: true, byKeys: false })).toEqual({ pick: "hit", index: 1 });
    expect(enterChoice({ active: 2, hits: 2, tail: 1, fresh: true, byKeys: false })).toEqual({ pick: "tail", index: 0 });
    expect(enterChoice({ active: 0, hits: 0, tail: 0, fresh: true, byKeys: false })).toBeNull();
  });
});
