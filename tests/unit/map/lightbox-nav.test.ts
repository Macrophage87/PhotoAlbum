import { describe, expect, it } from "vitest";
import { LOOK_AHEAD, lightboxNav } from "@/components/map/lightbox-nav";

const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

/** A lightbox whose lookups never answer, as on a slow connection: nothing it does may wait for them. */
function slow(start: number, gone = new Set<string>()) {
  const shown: number[] = [];
  const asked: string[][] = [];
  const nav = lightboxNav({ ids, start, isGone: (id) => gone.has(id), onShow: (i) => shown.push(i), prefetch: (few) => asked.push(few) });
  return { nav, shown, asked, gone };
}

describe("stepping through a map's photographs in the lightbox", () => {
  it("opens at once and looks up the photographs around it", () => {
    const { nav, shown, asked } = slow(0);
    nav.open();
    expect(shown).toEqual([0]);
    expect(asked[0]).toHaveLength(2 * LOOK_AHEAD + 1);
    expect(asked[0]).toEqual(expect.arrayContaining(["h", "i", "j", "a", "b", "c", "d"]));
  });

  it("lands on the right photograph after a quick series of presses, with no answer yet", () => {
    const { nav, shown } = slow(0);
    nav.open();
    nav.step(1);
    nav.step(1);
    nav.step(1);
    expect(nav.index).toBe(3);
    expect(shown).toEqual([0, 1, 2, 3]);
    nav.step(-1);
    nav.step(-1);
    nav.step(-1);
    nav.step(-1);
    // Round the end, as the lightbox always has.
    expect(nav.index).toBe(9);
  });

  it("steps past a photograph that is no longer there, in the direction of travel", () => {
    const { nav, shown, gone } = slow(0, new Set(["b", "c"]));
    nav.open();
    nav.step(1);
    expect(nav.index).toBe(3);
    nav.step(-1);
    expect(nav.index).toBe(0);
    // Found gone while on screen: moved off it, the way the last press went.
    gone.add("a");
    nav.recheck();
    expect(nav.index).toBe(9);
    expect(shown.at(-1)).toBe(9);
  });

  it("closes when nothing is left to show", () => {
    const { nav, shown, gone } = slow(0);
    nav.open();
    for (const id of ids) gone.add(id);
    nav.recheck();
    expect(shown.at(-1)).toBe(-1);
  });
});
