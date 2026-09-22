import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyEdits, contrastTerms, editedSize, editsSchema, hasEdits, LEVELS_PERCENTILES, LEVELS_SAMPLE_WIDTH, levelsOfRegion, levelsStretch, tidyEdits, warmthChannels } from "@/lib/images/edits";
import { EDITOR_SIZE, makeRenditions } from "@/lib/images/renditions";

/** A 200x100 image, left half red, right half blue, so a crop and a mirror are visible in the pixels. */
async function twoTone(): Promise<Buffer> {
  const left = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  const right = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 40, g: 40, b: 200 } } }).png().toBuffer();
  return sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 100, top: 0 }])
    .png()
    .toBuffer();
}

const pixel = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

describe("what counts as an edit", () => {
  it("ignores instructions that change nothing", () => {
    expect(hasEdits(null)).toBe(false);
    expect(hasEdits({})).toBe(false);
    expect(hasEdits({ brightness: 1, contrast: 1, saturation: 1, warmth: 0 })).toBe(false);
    expect(hasEdits({ crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false);
    expect(hasEdits({ brightness: 1.2 })).toBe(true);
    expect(hasEdits({ rotate: 90 })).toBe(true);
  });
  it("stores only what does something, so the badge is honest", () => {
    expect(tidyEdits({ brightness: 1, saturation: 1.4, crop: { x: 0, y: 0, w: 1, h: 1 }, flip: false })).toEqual({ saturation: 1.4 });
    expect(tidyEdits({ brightness: 1, rotate: 0 })).toBeNull();
  });
  it("refuses instructions outside what a darkroom would do", () => {
    expect(editsSchema.safeParse({ brightness: 9 }).success).toBe(false);
    expect(editsSchema.safeParse({ rotate: 45 }).success).toBe(false);
    expect(editsSchema.safeParse({ crop: { x: 0, y: 0, w: 0.01, h: 1 } }).success).toBe(false);
    expect(editsSchema.safeParse({ warmth: 40, saturation: 1.2 }).success).toBe(true);
  });
  it("says how big the picture ends up, so the row's dimensions match the file", () => {
    expect(editedSize(null, { width: 200, height: 100 })).toEqual({ width: 200, height: 100 });
    expect(editedSize({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }, { width: 200, height: 100 })).toEqual({ width: 100, height: 100 });
    expect(editedSize({ rotate: 90 }, { width: 200, height: 100 })).toEqual({ width: 100, height: 200 });
  });
});

describe("the numbers the preview and the server share", () => {
  it("warms the red channel and cools the blue, by the same amount either way", () => {
    const [r, , b] = warmthChannels(100);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(warmthChannels(0)).toEqual([1, 1, 1]);
    const [cr, , cb] = warmthChannels(-100);
    expect(cr).toBeLessThan(1);
    expect(cb).toBeGreaterThan(1);
  });
  it("pivots contrast around mid gray, so a neutral photo does not get darker", () => {
    const { mul, off } = contrastTerms(1.5);
    expect(mul * 128 + off).toBeCloseTo(128, 5);
    expect(contrastTerms(1)).toEqual({ mul: 1, off: 0 });
  });
});

describe("reading a picture's levels", () => {
  /** A row of pixels at the given luminances, as an ImageData-shaped object. */
  const strip = (values: number[]) => ({ width: values.length, height: 1, data: values.flatMap((v) => [v, v, v, 255]) });

  it("finds the ends of the range the picture actually uses", () => {
    const s = levelsOfRegion(strip(Array.from({ length: 100 }, (_, i) => 60 + i)), { x: 0, y: 0, w: 1, h: 1 })!;
    // Roughly 60 to 159, so the darkest goes to black and the lightest to white.
    expect(s.mul * 60 + s.off).toBeLessThan(10);
    expect(s.mul * 159 + s.off).toBeGreaterThan(245);
  });

  it("measures only the part the crop keeps, because that is what the server stretches", () => {
    // Dark on the left, bright on the right: cropping to one half must not see the other.
    const pixels = strip([...Array.from({ length: 50 }, () => 20), ...Array.from({ length: 50 }, () => 230)]);
    expect(levelsOfRegion(pixels, { x: 0, y: 0, w: 0.5, h: 1 })).toBeNull(); // a flat half has nothing to stretch
    const both = levelsOfRegion(pixels, { x: 0, y: 0, w: 1, h: 1 })!;
    expect(both.mul).toBeGreaterThan(1);
  });

  it("ignores what is transparent, and says nothing about an empty region", () => {
    const clear = { width: 2, height: 1, data: [10, 10, 10, 0, 250, 250, 250, 0] };
    expect(levelsOfRegion(clear, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it("samples small enough to re-read while a crop is dragged", () => {
    expect(LEVELS_SAMPLE_WIDTH).toBeLessThanOrEqual(256);
  });
});

describe("the levels stretch the preview and the server share", () => {
  it("maps the darkest kept tone to black and the brightest to white", () => {
    const s = levelsStretch(40, 200)!;
    expect(s.mul * 40 + s.off).toBeCloseTo(0, 5);
    expect(s.mul * 200 + s.off).toBeCloseTo(255, 5);
  });
  it("leaves a picture that already fills the range alone, rather than amplifying noise", () => {
    expect(levelsStretch(0, 255)!.mul).toBeCloseTo(1, 5);
    expect(levelsStretch(100, 102)).toBeNull();
    expect(levelsStretch(200, 40)).toBeNull();
  });
  it("asks the server for the same ends of the range the browser measures", () => {
    expect(LEVELS_PERCENTILES).toEqual({ lower: 1, upper: 99 });
  });
});

describe("applying the instructions to real pixels", () => {
  it("crops to the half that was asked for", async () => {
    const src = await twoTone();
    const out = await applyEdits(sharp(src), { crop: { x: 0, y: 0, w: 0.5, h: 1 } }, { width: 200, height: 100 }).png().toBuffer();
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([100, 100]);
    const [r, , b] = await pixel(out, 50, 50);
    expect(r).toBeGreaterThan(b); // the red half
  });

  it("mirrors left to right", async () => {
    const src = await twoTone();
    const out = await applyEdits(sharp(src), { flip: true }, { width: 200, height: 100 }).png().toBuffer();
    const [r, , b] = await pixel(out, 50, 50);
    expect(b).toBeGreaterThan(r); // the blue half is now on the left
  });

  it("turns the picture a quarter at a time", async () => {
    const src = await twoTone();
    const out = await applyEdits(sharp(src), { rotate: 90 }, { width: 200, height: 100 }).png().toBuffer();
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it("auto levels opens out a flat picture", async () => {
    // A picture that only uses the middle of the range: after auto levels it should reach much further.
    const flat = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 110, g: 110, b: 110 } } })
      .composite([{ input: await sharp({ create: { width: 20, height: 40, channels: 3, background: { r: 150, g: 150, b: 150 } } }).png().toBuffer(), left: 20, top: 0 }])
      .png()
      .toBuffer();
    const out = await applyEdits(sharp(flat), { auto: true }, { width: 40, height: 40 }).png().toBuffer();
    const dark = await pixel(out, 5, 20);
    const light = await pixel(out, 35, 20);
    expect(light[0] - dark[0]).toBeGreaterThan(150); // was a gap of 40
  });

  it("warms and brightens without touching what is in the picture", async () => {
    const src = await twoTone();
    const plain = await pixel(await sharp(src).png().toBuffer(), 50, 50);
    const out = await applyEdits(sharp(src), { warmth: 100, brightness: 1.3 }, { width: 200, height: 100 }).png().toBuffer();
    const warm = await pixel(out, 50, 50);
    expect(warm[0]).toBeGreaterThan(plain[0]);
    expect(warm[2]).toBeLessThanOrEqual(Math.max(plain[2], warm[0]));
  });
});

describe("rendering an edited item", () => {
  it("writes a full-size copy alongside the usual sizes, and only when there are edits", async () => {
    const src = await twoTone();
    const written: string[] = [];
    const put = async (key: string) => { written.push(key); };

    const plain = await makeRenditions(src, "p/1", put);
    expect(Object.keys(plain.renditions).sort()).toEqual(["medium", "thumb"]);
    expect([plain.width, plain.height]).toEqual([200, 100]);

    written.length = 0;
    const edited = await makeRenditions(src, "p/1", put, { crop: { x: 0, y: 0, w: 0.5, h: 1 }, saturation: 1.2 });
    expect(written).toContain("p/1/edited.webp");
    // …and the picture without the edits, which is what the editor opens so it does not apply them twice.
    expect(written).toContain("p/1/source.webp");
    expect(edited.renditions.source).toBeTruthy();
    // The editor's copy is deliberately smaller than the one the album shows: it costs a phone less to load and filter.
    expect(edited.renditions.source!.w).toBeLessThanOrEqual(EDITOR_SIZE);
    expect(edited.renditions.full).toBeTruthy();
    // The dimensions on the row describe the picture the album shows, not the file on disk.
    expect([edited.width, edited.height]).toEqual([100, 100]);
  });
});
