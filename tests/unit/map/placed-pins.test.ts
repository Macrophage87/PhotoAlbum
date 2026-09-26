import { describe, expect, it } from "vitest";
import { spreadFeatures, withMoved } from "@/lib/map/jitter";

type P = { id: string; caption: string };
const pin = (id: string, lng: number, lat: number): GeoJSON.Feature<GeoJSON.Point, P> => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { id, caption: id } });

describe("pins placed in the browser", () => {
  it("fans out photographs put on exactly one spot, so each pin can be tapped (#96)", () => {
    const out = spreadFeatures([pin("a", -76.6, 39.3), pin("b", -76.6, 39.3), pin("c", -76.6, 39.3), pin("d", 2.35, 48.85)]);
    const spots = new Set(out.map((f) => f.geometry.coordinates.join(",")));
    expect(spots.size).toBe(4);
    // The first keeps the real spot, a lone pin is untouched, and the properties ride along.
    expect(out[0].geometry.coordinates).toEqual([-76.6, 39.3]);
    expect(out[3].geometry.coordinates).toEqual([2.35, 48.85]);
    expect(out.map((f) => f.properties.caption)).toEqual(["a", "b", "c", "d"]);
  });

  it("shows a moved pin once, where it now is, not also where it was (#94)", () => {
    const base = [pin("a", 1, 1), pin("b", 2, 2)];
    const moved = new Map([["a", pin("a", 5, 5)], ["new", pin("new", 6, 6)]]);
    const out = withMoved(base, moved);
    expect(out.filter((f) => f.properties.id === "a").map((f) => f.geometry.coordinates)).toEqual([[5, 5]]);
    expect(out.map((f) => f.properties.id).sort()).toEqual(["a", "b", "new"]);
    expect(withMoved(base, new Map())).toBe(base);
  });
});
