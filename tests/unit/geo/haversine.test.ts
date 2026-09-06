import { describe, expect, it } from "vitest";
import { haversine } from "@/lib/geo/haversine";
import { degreesToSemicircles, semicirclesToDegrees, FIT_INVALID_SINT32 } from "@/lib/geo/semicircles";
import { boundsOf, isValidCoord } from "@/lib/geo/bounds";

describe("geo", () => {
  it("haversine matches known distances", () => {
    // Bar Harbor -> Portland, ME ≈ 172 km
    expect(haversine(44.3876, -68.2039, 43.6591, -70.2568)).toBeCloseTo(179_000, -4);
    expect(haversine(0, 0, 0, 1)).toBeCloseTo(111_195, -2);
    expect(haversine(44.35, -68.2, 44.35, -68.2)).toBe(0);
  });
  it("semicircle conversion round-trips", () => {
    expect(semicirclesToDegrees(degreesToSemicircles(44.35))!).toBeCloseTo(44.35, 6);
    expect(semicirclesToDegrees(FIT_INVALID_SINT32)).toBeNull();
  });
  it("bounds and coordinate validity", () => {
    expect(boundsOf([{ lat: 1, lng: 2 }, { lat: -1, lng: 5 }])).toEqual({ minLat: -1, maxLat: 1, minLng: 2, maxLng: 5 });
    expect(isValidCoord(0, 0)).toBe(false);
    expect(isValidCoord(91, 0)).toBe(false);
    expect(isValidCoord(44.35, -68.2)).toBe(true);
  });
});
