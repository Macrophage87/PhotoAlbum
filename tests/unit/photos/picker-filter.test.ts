import { describe, expect, it } from "vitest";
import { boundingBox, describePickerFilter, MILE_IN_METRES, NO_PICKER_FILTER, parsePickerFilter, pickerFilterIsActive, pickerFilterQuery } from "@/lib/photos/picker-filter";
import { haversine } from "@/lib/geo/haversine";

describe("reading what the picker was asked for", () => {
  it("takes words, a trip, a stretch of days, a kind, a member and a point", () => {
    const f = parsePickerFilter({ q: "  lake  house ", trip: "t1", from: "2025-08-01", to: "2025-08-31", kind: "PHOTO", uploader: "u1", lat: "44.35", lng: "-68.2", miles: "25", place: "Acadia" });
    expect(f).toMatchObject({ q: "lake house", trip: "t1", from: "2025-08-01", to: "2025-08-31", kind: "PHOTO", uploaderId: "u1" });
    expect(f.near).toEqual({ lat: 44.35, lng: -68.2, miles: 25, label: "Acadia" });
  });

  it("is nothing at all when nothing was asked", () => {
    expect(parsePickerFilter({})).toEqual(NO_PICKER_FILTER);
    expect(pickerFilterIsActive(NO_PICKER_FILTER)).toBe(false);
  });

  it("asks for the ones nothing has claimed only when the box is ticked", () => {
    expect(parsePickerFilter({ loose: "1" }).loose).toBe(true);
    expect(parsePickerFilter({}).loose).toBe(false);
    expect(pickerFilterIsActive(parsePickerFilter({ loose: "1" }))).toBe(true);
  });

  it("throws away a day that is not a day and a place that is not a place", () => {
    expect(parsePickerFilter({ from: "last summer" }).from).toBeNull();
    expect(parsePickerFilter({ lat: "999", lng: "0" }).near).toBeNull();
    expect(parsePickerFilter({ lat: "44.3" }).near).toBeNull(); // half a point is no point
  });

  it("falls back to a sensible distance when asked for an odd one", () => {
    expect(parsePickerFilter({ lat: "44", lng: "-68", miles: "7" }).near?.miles).toBe(25);
    expect(parsePickerFilter({ lat: "44", lng: "-68", miles: "100" }).near?.miles).toBe(100);
  });

  it("goes back into a URL so paging keeps every part of it", () => {
    const f = parsePickerFilter({ q: "lake", loose: "1", lat: "44", lng: "-68", miles: "5", place: "Home" });
    const round = parsePickerFilter(Object.fromEntries(new URLSearchParams(pickerFilterQuery(f)).entries()));
    expect(round).toEqual(f);
  });

  it("says what it is showing, in words a person would use", () => {
    const said = describePickerFilter(parsePickerFilter({ q: "lake", loose: "1", from: "2025-08-01", to: "2025-08-31", lat: "44", lng: "-68", miles: "5", place: "Home" }));
    expect(said).toContain("words: lake");
    expect(said).toContain("in no trip and no collection");
    expect(said).toContain("2025-08-01 to 2025-08-31");
    expect(said).toContain("within 5 miles of Home");
  });
});

/**
 * The box is the sieve the database can use its index on; the real distance is measured afterwards. It only has to
 * be big enough — anything it lets through in error is dropped by the measurement, but anything it wrongly excludes
 * is lost for good.
 */
describe("the box that holds everything within a distance", () => {
  it("reaches at least as far as asked in every direction", () => {
    const [lat, lng, miles] = [44.35, -68.2, 25];
    const box = boundingBox(lat, lng, miles);
    const metres = miles * MILE_IN_METRES;
    expect(haversine(lat, lng, box.latMax, lng)).toBeGreaterThanOrEqual(metres);
    expect(haversine(lat, lng, box.latMin, lng)).toBeGreaterThanOrEqual(metres);
    expect(haversine(lat, lng, lat, box.lngMax)).toBeGreaterThanOrEqual(metres);
    expect(haversine(lat, lng, lat, box.lngMin)).toBeGreaterThanOrEqual(metres);
  });

  it("widens as the longitudes crowd together towards the poles", () => {
    const equator = boundingBox(0, 0, 25);
    const far = boundingBox(70, 0, 25);
    expect(far.lngMax - far.lngMin).toBeGreaterThan(equator.lngMax - equator.lngMin);
  });

  it("opens out to every longitude at the pole itself, where they all meet", () => {
    const box = boundingBox(89.999, 0, 25);
    expect(box.lngMin).toBe(-180);
    expect(box.lngMax).toBe(180);
  });

  it("never asks for a latitude that does not exist", () => {
    const box = boundingBox(89.9, 0, 500);
    expect(box.latMax).toBeLessThanOrEqual(90);
    expect(boundingBox(-89.9, 0, 500).latMin).toBeGreaterThanOrEqual(-90);
  });
});
