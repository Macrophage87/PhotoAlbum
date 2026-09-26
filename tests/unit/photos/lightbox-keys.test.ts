import { describe, expect, it } from "vitest";
import { lightboxKeyAction } from "@/components/photos/Lightbox";

/** A stand-in for an element: `closest` answers for any selector naming one of the given tags or attributes. */
const el = (...matches: string[]) => ({ closest: (selector: string) => (matches.some((m) => selector.includes(m)) ? {} : null) });
const press = (key: string, target: unknown = el(), defaultPrevented = false) => lightboxKeyAction({ key, target: target as EventTarget, defaultPrevented });

describe("the lightbox's keys (#74)", () => {
  it("changes photos on the arrows, and closes on Escape, when nothing else wants them", () => {
    expect(press("ArrowLeft")).toBe("prev");
    expect(press("ArrowRight")).toBe("next");
    expect(press("Escape")).toBe("close");
    expect(press("a")).toBeNull();
    expect(press("ArrowRight", null)).toBe("next");
  });

  it("leaves the arrows to a field being typed in, so the caret moves and the draft is not thrown away", () => {
    expect(press("ArrowLeft", el("input"))).toBeNull();
    expect(press("ArrowRight", el("textarea"))).toBeNull();
    expect(press("ArrowRight", el("select"))).toBeNull();
    expect(press("ArrowLeft", { isContentEditable: true })).toBeNull();
  });

  it("leaves them to a panorama, a map or a scan that is being looked around", () => {
    expect(press("ArrowRight", el("data-testid=panorama-view"))).toBeNull();
    expect(press("ArrowLeft", el(".maplibregl-map"))).toBeNull();
    expect(press("ArrowLeft", el("model-viewer"))).toBeNull();
  });

  it("does nothing with a key something else has already handled", () => {
    expect(press("ArrowLeft", el(), true)).toBeNull();
    expect(press("Escape", el(), true)).toBeNull();
  });
});
