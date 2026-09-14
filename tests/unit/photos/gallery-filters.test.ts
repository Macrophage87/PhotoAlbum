import { describe, expect, it } from "vitest";
import { describeCount, filterIsActive, filterQuery, NO_FILTER, parseGalleryFilter } from "@/lib/photos/filters";
import { intersectIds } from "@/lib/photos/page";

/**
 * Reading a filter off the address bar. Everything comes from a query string somebody can edit by hand, so nothing
 * is trusted: an unknown kind, a year that never had photographs in it, or a uploader asked for by a visitor who is
 * not a member of the family all have to come back as "no such filter" rather than as a query.
 */
describe("reading a gallery filter from the address bar", () => {
  const member = { member: true };

  it("takes words, who, what, when and where in the trip", () => {
    const f = parseGalleryFilter({ q: "  lighthouse  at   dusk ", uploader: "u1", kind: "SCAN", year: "2019", activity: "a1" }, member);
    expect(f).toEqual({ q: "lighthouse at dusk", uploaderId: "u1", kind: "SCAN", year: 2019, activityId: "a1" });
    expect(filterIsActive(f)).toBe(true);
  });

  it("is no filter at all when nothing was asked for", () => {
    expect(parseGalleryFilter({}, member)).toEqual(NO_FILTER);
    expect(filterIsActive(NO_FILTER)).toBe(false);
    // Blank and whitespace-only values are the same as nothing, not as a search for "".
    expect(filterIsActive(parseGalleryFilter({ q: "   ", uploader: "" }, member))).toBe(false);
  });

  it("never lets an anonymous visitor filter by who uploaded something", () => {
    // They are not shown the list of the family's names, and must not be able to ask by id either.
    expect(parseGalleryFilter({ uploader: "u1" }, { member: false }).uploaderId).toBeNull();
  });

  it("throws away a kind the album does not have, and a year that could not be one", () => {
    expect(parseGalleryFilter({ kind: "DRAWING" }, member).kind).toBeNull();
    expect(parseGalleryFilter({ year: "nineteen" }, member).year).toBeNull();
    expect(parseGalleryFilter({ year: "1600" }, member).year).toBeNull();
    expect(parseGalleryFilter({ year: "1999" }, member).year).toBe(1999);
  });

  it("caps a very long search rather than sending it on", () => {
    expect(parseGalleryFilter({ q: "a".repeat(500) }, member).q).toHaveLength(200);
  });

  it("takes the first of a repeated parameter rather than tripping over the array", () => {
    expect(parseGalleryFilter({ q: ["boat", "car"] }, member).q).toBe("boat");
  });

  it("goes back into a URL so that paging keeps the narrowing", () => {
    const f = parseGalleryFilter({ q: "boat house", uploader: "u1", year: "2019" }, member);
    const round = new URLSearchParams(filterQuery(f));
    expect(round.get("q")).toBe("boat house");
    expect(round.get("uploader")).toBe("u1");
    expect(round.get("year")).toBe("2019");
    expect(filterQuery(NO_FILTER)).toBe("");
  });
});

describe("saying how much of the gallery is being shown", () => {
  it("counts plainly when nothing is filtered", () => {
    expect(describeCount(412, 412, false)).toBe("412 items");
  });

  it("says how many of how many once something is", () => {
    expect(describeCount(7, 412, true)).toBe("7 of 412 items");
    expect(describeCount(0, 412, true)).toBe("Nothing matches");
  });
});

describe("combining two things a filter asked for", () => {
  it("keeps only what is in every list", () => {
    expect(intersectIds([["a", "b", "c"], ["b", "c", "d"]])).toEqual(["b", "c"]);
    expect(intersectIds([["a"], ["b"]])).toEqual([]);
  });

  it("leaves a single list alone", () => {
    expect(intersectIds([["a", "b"]])).toEqual(["a", "b"]);
  });
});
