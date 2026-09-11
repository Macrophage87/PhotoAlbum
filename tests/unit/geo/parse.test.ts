import { describe, expect, it } from "vitest";
import { parseLatLng } from "@/lib/geo/parse";

describe("parseLatLng", () => {
  it("accepts in-range pairs and rounds them", () => {
    expect(parseLatLng("44.31864321", " -68.19171234 ")).toEqual({ lat: 44.318643, lng: -68.191712 });
  });
  it("rejects blanks, text, out-of-range values and the null island sentinel", () => {
    expect(parseLatLng("", "")).toBeNull();
    expect(parseLatLng("north", "-68")).toBeNull();
    expect(parseLatLng("91", "0")).toBeNull();
    expect(parseLatLng("0", "181")).toBeNull();
    expect(parseLatLng("0", "0")).toBeNull();
  });
});
