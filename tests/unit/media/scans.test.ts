import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOWED_MIMES, EXT_BY_MIME, EXT_MIME, kindForMime, scanFormatOf, scanIsViewable } from "@/lib/media/mime";

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

describe("the files a phone scanner exports", () => {
  it("takes what Scaniverse hands over, by extension, since browsers say little about them", () => {
    for (const [ext, mime] of [["glb", "model/gltf-binary"], ["usdz", "model/vnd.usdz+zip"], ["ply", "application/x-ply"], ["spz", "application/x-spz"]] as const) {
      expect(EXT_MIME[ext]).toBe(mime);
      expect(ALLOWED_MIMES.has(mime)).toBe(true);
      expect(EXT_BY_MIME[mime]).toBe(ext);
      expect(kindForMime(mime)).toBe("SCAN");
    }
  });

  it("still knows a photograph from a clip", () => {
    expect(kindForMime("image/jpeg")).toBe("PHOTO");
    expect(kindForMime("video/mp4")).toBe("VIDEO");
    expect(scanFormatOf("image/jpeg")).toBeNull();
  });

  it("knows which of them a browser can actually draw", () => {
    expect(scanFormatOf("model/gltf-binary")).toBe("GLB");
    expect(scanIsViewable("GLB")).toBe(true);
    // A splat is a cloud of points, and Apple's own format is Apple's own: both are kept whole instead.
    expect(scanIsViewable("PLY")).toBe(false);
    expect(scanIsViewable("SPZ")).toBe(false);
    expect(scanIsViewable("USDZ")).toBe(false);
    expect(scanIsViewable(null)).toBe(false);
  });
});

describe("the scan fixture", () => {
  it("is a real glTF binary, which is what makes the viewer test worth anything", () => {
    const buf = readFileSync(fixture("scan.glb"));
    expect(buf.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(buf.readUInt32LE(4)).toBe(2);
    // The header's length is the whole file, and the first chunk is the JSON scene description.
    expect(buf.readUInt32LE(8)).toBe(buf.length);
    expect(buf.subarray(16, 20).toString("ascii")).toBe("JSON");
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes).toHaveLength(1);
  });
});
