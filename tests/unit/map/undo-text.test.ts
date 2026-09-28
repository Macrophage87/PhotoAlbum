import { describe, expect, it } from "vitest";
import { undoneText } from "@/lib/map/undo-text";

describe("what the placing screen says after an Undo", () => {
  it("says they are back when every one came back", () => {
    expect(undoneText(1, 0)).toBe("Undone. It is back where it was.");
    expect(undoneText(3, 0)).toBe("Undone. They are back where they were.");
  });

  it("says how many had changed since and were left as they are", () => {
    expect(undoneText(2, 1)).toBe("Undone. 2 are back where they were. 1 had changed since, left as it is.");
    expect(undoneText(0, 2)).toBe("Nothing was undone: 2 had changed since, left as they are.");
  });
});
