import { describe, expect, it } from "vitest";
import { uploaderLabel } from "@/components/photos/toGrid";
import { tileCoords } from "@/components/map/StaticMapTile";
import { formatTaken, wallInputValue } from "@/components/photos/LightboxInfo";

describe("uploader labels", () => {
  it("uses the name, else the part of the address before the @, else a neutral phrase", () => {
    expect(uploaderLabel("Grandma Jo", "jo@example.com")).toBe("Grandma Jo");
    expect(uploaderLabel("  ", "sjcieply@gmail.com")).toBe("sjcieply");
    expect(uploaderLabel(null, null)).toBe("a family member");
  });
});

describe("the viewer's side panel", () => {
  it("places a point on the right tile", () => {
    const { x, y } = tileCoords(0, 0, 1);
    expect([x, y]).toEqual([1, 1]);
    const t = tileCoords(44.3186, -68.1917, 13);
    expect(Math.floor(t.x)).toBe(2544);
    expect(Math.floor(t.y)).toBe(2968);
  });
  it("shows and edits the wall-clock time in the photo's own zone", () => {
    expect(formatTaken("2025-08-12T19:04:05.000Z", -240)).toContain("3:04 PM");
    expect(formatTaken("2025-08-12T19:04:05.000Z", -240)).toContain("Aug 12, 2025");
    expect(wallInputValue("2025-08-12T19:04:05.000Z", -240)).toBe("2025-08-12T15:04");
    expect(wallInputValue("2025-08-12T19:04:05.000Z", null)).toBe("2025-08-12T19:04");
  });
});
