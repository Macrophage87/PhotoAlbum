import { describe, expect, it } from "vitest";
import { advancedIsActive, describeCount, filterIsActive, filterQuery, MAX_PEOPLE, NO_FILTER, parseGalleryFilter } from "@/lib/photos/filters";
import { intersectIds } from "@/lib/photos/page";

/**
 * Reading a filter off the address bar. Everything comes from a query string somebody can edit by hand, so nothing
 * is trusted: an unknown kind, a year that never had photographs in it, or a uploader asked for by a visitor who is
 * not a member of the family all have to come back as "no such filter" rather than as a query.
 */
describe("reading a gallery filter from the address bar", () => {
  const member = { member: true };

  it("takes words, who uploaded it, who is in it, what, when and where in the trip", () => {
    const f = parseGalleryFilter({ q: "  lighthouse  at   dusk ", uploader: "u1", person: "p1", kind: "SCAN", year: "2019", activity: "a1" }, member);
    expect(f).toEqual({ q: "lighthouse at dusk", uploaderId: "u1", personIds: ["p1"], kind: "SCAN", year: 2019, activityId: "a1" });
    expect(filterIsActive(f)).toBe(true);
  });

  it("takes several names at once, meaning the ones they are all in", () => {
    // A form with several rows chosen sends the same name over and over; two names is "Ada and Ben together".
    expect(parseGalleryFilter({ person: ["p1", "p2"] }, member).personIds).toEqual(["p1", "p2"]);
    // Asked for twice is asked for once, and a blank among them is not a name.
    expect(parseGalleryFilter({ person: ["p1", "p1", " ", "p2"] }, member).personIds).toEqual(["p1", "p2"]);
    // A hand-written address with a hundred names in it is not a family looking for a photograph.
    expect(parseGalleryFilter({ person: Array.from({ length: 50 }, (_, i) => `p${i}`) }, member).personIds).toHaveLength(MAX_PEOPLE);
  });

  it("puts every name back into the address, so a narrowed page keeps all of them", () => {
    const f = parseGalleryFilter({ person: ["p1", "p2"] }, member);
    expect(new URLSearchParams(filterQuery(f)).getAll("person")).toEqual(["p1", "p2"]);
  });

  it("knows when something beyond the words is being asked, so the extra questions arrive open", () => {
    expect(advancedIsActive(parseGalleryFilter({ q: "boat" }, member))).toBe(false);
    expect(advancedIsActive(parseGalleryFilter({ person: "p1" }, member))).toBe(true);
    expect(advancedIsActive(parseGalleryFilter({ person: ["p1", "p2"] }, member))).toBe(true);
    expect(advancedIsActive(parseGalleryFilter({ uploader: "u1" }, member))).toBe(true);
  });

  it("is no filter at all when nothing was asked for", () => {
    expect(parseGalleryFilter({}, member)).toEqual(NO_FILTER);
    expect(filterIsActive(NO_FILTER)).toBe(false);
    // Blank and whitespace-only values are the same as nothing, not as a search for "".
    expect(filterIsActive(parseGalleryFilter({ q: "   ", uploader: "" }, member))).toBe(false);
  });

  it("never lets an anonymous visitor filter by who uploaded something, nor by who is in it", () => {
    // They are not shown the list of the family's names, and must not be able to ask by id either. Asking a public
    // trip for "the ones with Ada in them" would otherwise tell a stranger exactly which of them she is on.
    expect(parseGalleryFilter({ uploader: "u1" }, { member: false }).uploaderId).toBeNull();
    expect(parseGalleryFilter({ person: "p1" }, { member: false }).personIds).toEqual([]);
    expect(filterIsActive(parseGalleryFilter({ person: "p1" }, { member: false }))).toBe(false);
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
    const f = parseGalleryFilter({ q: "boat house", uploader: "u1", person: "p1", year: "2019" }, member);
    const round = new URLSearchParams(filterQuery(f));
    expect(round.get("q")).toBe("boat house");
    expect(round.get("uploader")).toBe("u1");
    expect(round.getAll("person")).toEqual(["p1"]);
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
