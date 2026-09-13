import { describe, expect, it } from "vitest";
import { hasEdits, tidyEdits, type PhotoEdits } from "@/lib/images/edits";

/**
 * What a batch auto-colour does to the instructions already on a photograph. The correction itself is worked out
 * per photograph when it is rendered — a sunset and a kitchen need different ones — so what is stored is only the
 * word "auto", beside whatever a member had set by hand.
 */
describe("adding auto levels to instructions that are already there", () => {
  const crop: PhotoEdits = { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, rotate: 90, warmth: 20 };

  it("leaves a crop, a turn and a warmth exactly as they were", () => {
    const next = tidyEdits({ ...crop, auto: true })!;
    expect(next).toMatchObject({ crop: crop.crop, rotate: 90, warmth: 20, auto: true });
  });

  it("turns a photograph with nothing on it into one with just auto levels", () => {
    const next = tidyEdits({ auto: true })!;
    expect(next).toEqual({ auto: true });
    expect(hasEdits(next)).toBe(true);
  });

  it("hands back the batch by forgetting only that one instruction", () => {
    const corrected = tidyEdits({ ...crop, auto: true })!;
    const back = tidyEdits({ ...corrected, auto: false })!;
    expect(back.auto).toBeUndefined();
    expect(back).toMatchObject({ crop: crop.crop, rotate: 90, warmth: 20 });
  });

  it("leaves a photograph nobody had touched with no instructions at all, not an empty set", () => {
    const corrected = tidyEdits({ auto: true })!;
    expect(tidyEdits({ ...corrected, auto: false })).toBeNull();
  });
});
