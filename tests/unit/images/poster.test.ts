import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { stillIsBlank } from "@/lib/images/poster";

const statsOf = async (img: ReturnType<typeof sharp>) => {
  const png = await img.png().toBuffer();
  return (await sharp(png).stats()).channels;
};

/**
 * What a browser sends back for a 3D scan. A capture taken before the scan is drawn is a rectangle of one colour —
 * white on an iPhone, black on a desktop, transparent where the transparency survived — and the album must not
 * keep any of them: a tile taken once is never taken again.
 */
describe("deciding whether a scan's still is a picture of anything", () => {
  it("throws away a white rectangle, which is what an iPhone writes for an empty frame", async () => {
    const white = sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } });
    expect(stillIsBlank(await statsOf(white))).toBe(true);
  });

  it("throws away a black one, which is what a desktop writes for the same frame", async () => {
    const black = sharp({ create: { width: 64, height: 64, channels: 3, background: "#000000" } });
    expect(stillIsBlank(await statsOf(black))).toBe(true);
  });

  it("throws away one that kept its transparency and drew nothing into it", async () => {
    const empty = sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    expect(stillIsBlank(await statsOf(empty))).toBe(true);
  });

  it("throws away one where the scan is a speck, too little of the frame to be a tile", async () => {
    const speck = sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } }, left: 0, top: 0 }]);
    // 64 of 40,000 pixels: well under the one per cent a real scan covers.
    expect(stillIsBlank(await statsOf(speck))).toBe(true);
  });

  it("keeps a still with the scan actually drawn in it", async () => {
    const drawn = sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: 120, height: 120, channels: 4, background: { r: 90, g: 140, b: 60, alpha: 1 } } }, left: 40, top: 40 }]);
    expect(stillIsBlank(await statsOf(drawn))).toBe(false);
  });

  it("says nothing arrived when the bytes were not a picture at all", () => {
    expect(stillIsBlank([])).toBe(true);
  });
});
