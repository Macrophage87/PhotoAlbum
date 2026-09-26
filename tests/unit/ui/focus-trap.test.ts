import { describe, expect, it } from "vitest";
import { canTakeFocus, trapTarget } from "@/components/ui/focus-trap";

describe("keeping Tab inside a modal", () => {
  const [a, b, c] = ["a", "b", "c"];

  it("wraps from the last to the first, and back with Shift", () => {
    expect(trapTarget([a, b, c], c, false, true)).toBe(a);
    expect(trapTarget([a, b, c], a, true, true)).toBe(c);
  });

  it("leaves Tab alone in the middle", () => {
    expect(trapTarget([a, b, c], b, false, true)).toBeNull();
    expect(trapTarget([a, b, c], b, true, true)).toBeNull();
  });

  it("brings focus back in when it has got outside", () => {
    expect(trapTarget([a, b, c], "elsewhere", false, false)).toBe(a);
    expect(trapTarget([a, b, c], null, true, false)).toBe(c);
  });

  it("does nothing with nowhere to go", () => {
    expect(trapTarget([], null, false, false)).toBeNull();
  });

  it("counts only what Tab itself would stop at: in the tab order, enabled and drawn", () => {
    const shown = { getClientRects: () => ({ length: 1 }) };
    const hidden = { getClientRects: () => ({ length: 0 }) };
    expect(canTakeFocus({ tabIndex: 0, ...shown })).toBe(true);
    expect(canTakeFocus({ tabIndex: -1, ...shown })).toBe(false);
    expect(canTakeFocus({ tabIndex: 0, disabled: true, ...shown })).toBe(false);
    expect(canTakeFocus({ tabIndex: 0, ...hidden })).toBe(false);
    expect(canTakeFocus({ tabIndex: 0, ...shown }, "hidden")).toBe(false);
    expect(canTakeFocus({ tabIndex: 0, ...shown }, "visible")).toBe(true);
  });
});
