import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { gpanoFrom, isPanoramaShape, panoramaAxis, panoramaLabel, PANORAMA_RATIO } from "@/lib/images/panorama";
import { readGPano } from "@/lib/images/panorama-read";
import { makeRenditions } from "@/lib/images/renditions";

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

describe("recognizing a panorama by its shape", () => {
  it("leaves ordinary photographs alone, however wide the crop", () => {
    expect(isPanoramaShape(4032, 3024)).toBe(false); // a phone's usual 4:3
    expect(isPanoramaShape(3840, 2160)).toBe(false); // 16:9
    expect(isPanoramaShape(4000, 2000)).toBe(false); // a 2:1 crop is still a photograph
  });

  it("takes a swept horizon, and a tower shot from pavement to sky", () => {
    expect(isPanoramaShape(12000, 2400)).toBe(true);
    expect(isPanoramaShape(2400, 12000)).toBe(true);
    expect(panoramaAxis(12000, 2400)).toBe("horizontal");
    expect(panoramaAxis(2400, 12000)).toBe("vertical");
  });

  it("says nothing about a photo whose size is unknown", () => {
    expect(isPanoramaShape(0, 0)).toBe(false);
    expect(PANORAMA_RATIO).toBeGreaterThan(2);
  });
});

describe("what the camera itself claimed", () => {
  it("reads a full 360 as one that wraps round", () => {
    const g = gpanoFrom({ ProjectionType: "equirectangular", UsePanoramaViewer: "True", FullPanoWidthPixels: "8000", CroppedAreaImageWidthPixels: "8000" });
    expect(g).toEqual({ projection: "EQUIRECTANGULAR_360", coverage: 1 });
    expect(panoramaLabel(g!.projection)).toBe("360° panorama");
  });

  it("reads a part of the way round as a panorama with two ends", () => {
    const g = gpanoFrom({ ProjectionType: "equirectangular", FullPanoWidthPixels: "8000", CroppedAreaImageWidthPixels: "4000" });
    expect(g).toMatchObject({ projection: "EQUIRECTANGULAR", coverage: 0.5 });
    expect(panoramaLabel(g!.projection)).toBe("Panorama");
  });

  it("takes a stitched cylindrical sweep, and ignores a file that says nothing", () => {
    expect(gpanoFrom({ ProjectionType: "cylindrical" })).toMatchObject({ projection: "CYLINDRICAL" });
    expect(gpanoFrom({ Make: "Apple" })).toBeNull();
    expect(gpanoFrom(null)).toBeNull();
  });

  it("finds the tags in a real file's XMP", async () => {
    expect(await readGPano(fixture("panorama.jpg"))).toEqual({ projection: "EQUIRECTANGULAR_360", coverage: 1 });
    // A photo with no XMP at all is not a panorama, and reading it must not throw.
    expect(await readGPano(fixture("photo-with-gps.jpg"))).toBeNull();
  });
});

describe("what gets rendered", () => {
  it("marks a 2:1 equirectangular photo as a panorama on the camera's word, where its shape alone would not", async () => {
    const written: string[] = [];
    const r = await makeRenditions(fixture("panorama.jpg"), "photos/x", async (key) => { written.push(key); }, null, { projection: "EQUIRECTANGULAR_360", coverage: 1 });
    expect(r.panorama).toBe(true);
    expect(isPanoramaShape(r.width, r.height)).toBe(false);
    // 2400 px across is longer than the 1600 the medium copy stops at, so the long copy is worth keeping.
    expect(written).toContain("photos/x/pano.webp");
    expect(r.renditions.pano?.w).toBe(2400);
  });

  it("gives an ordinary photo no panorama copy", async () => {
    const written: string[] = [];
    const r = await makeRenditions(fixture("photo-with-gps.jpg"), "photos/y", async (key) => { written.push(key); });
    expect(r.panorama).toBe(false);
    expect(written).not.toContain("photos/y/pano.webp");
    expect(r.renditions.pano).toBeUndefined();
  });
});
