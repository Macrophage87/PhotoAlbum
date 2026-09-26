import { describe, expect, it } from "vitest";
import { pageNumber, timelinePages } from "@/lib/timeline/paging";
import { thinLine } from "@/lib/tracks/simplify";

describe("pages of the timeline of everything", () => {
  const limits = { trips: 3, photos: 100 };

  it("puts a handful of small trips on each page rather than the whole album on one", () => {
    expect(timelinePages([10, 10, 10, 10, 10, 10, 10], limits)).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 7 }]);
  });

  it("closes a page early once its photographs pass the budget, and gives a trip bigger than that a page of its own", () => {
    expect(timelinePages([60, 50, 500, 5, 5], limits)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 5 }]);
  });

  it("keeps trips with nothing in them yet, since their outings are still on the timeline", () => {
    expect(timelinePages([0, 0, 0, 0], limits)).toEqual([{ start: 0, end: 3 }, { start: 3, end: 4 }]);
  });

  it("has no pages for no trips", () => {
    expect(timelinePages([], limits)).toEqual([]);
  });

  it("reads the page from the address, kept within the pages there are", () => {
    expect(pageNumber(undefined, 4)).toBe(1);
    expect(pageNumber("3", 4)).toBe(3);
    expect(pageNumber(["2", "3"], 4)).toBe(2);
    expect(pageNumber("99", 4)).toBe(4);
    expect(pageNumber("-2", 4)).toBe(1);
    expect(pageNumber("lots", 4)).toBe(1);
    expect(pageNumber("2", 0)).toBe(1);
  });
});

describe("thinning a line for a small drawing", () => {
  it("keeps both ends and never more points than asked", () => {
    const line = Array.from({ length: 5000 }, (_, i) => i);
    const thin = thinLine(line, 200);
    expect(thin).toHaveLength(200);
    expect(thin[0]).toBe(0);
    expect(thin[199]).toBe(4999);
    // Evenly along it, in order.
    expect([...thin].sort((a, b) => a - b)).toEqual(thin);
    expect(new Set(thin).size).toBe(200);
  });

  it("leaves a line that is already short enough alone", () => {
    const line = [1, 2, 3];
    expect(thinLine(line, 200)).toBe(line);
  });
});
