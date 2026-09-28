import { describe, expect, it } from "vitest";
import { pageNumber, timelinePage, timelinePageHref, timelinePages } from "@/lib/timeline/paging";

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

describe("which trips a page of the timeline of everything shows", () => {
  // Twelve small trips, newest first as the page lists them, and one big one in the middle.
  const trips = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}` }));
  const counts = new Map(trips.map((t, i) => [t.id, i === 6 ? 2000 : 10]));
  const ids = (r: { onPage: { id: string }[] }) => r.onPage.map((t) => t.id);

  it("shows the first page's trips when no page is asked for, and each later page the next ones in order", () => {
    const first = timelinePage(trips, counts, { searching: false, page: undefined });
    expect(first).toMatchObject({ page: 1, pages: 4 });
    expect(ids(first)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(ids(timelinePage(trips, counts, { searching: false, page: "2" }))).toEqual(["t5"]);
    // The big trip is a page to itself.
    expect(ids(timelinePage(trips, counts, { searching: false, page: "3" }))).toEqual(["t6"]);
    expect(ids(timelinePage(trips, counts, { searching: false, page: "4" }))).toEqual(["t7", "t8", "t9", "t10", "t11"]);
  });

  it("takes a page past the end as the last page and nonsense as the first", () => {
    expect(timelinePage(trips, counts, { searching: false, page: "40" })).toMatchObject({ page: 4 });
    expect(ids(timelinePage(trips, counts, { searching: false, page: "40" }))).toEqual(["t7", "t8", "t9", "t10", "t11"]);
    expect(timelinePage(trips, counts, { searching: false, page: "0" })).toMatchObject({ page: 1 });
  });

  it("pages a search over only the trips it found something on", () => {
    const found = new Map([["t3", 2], ["t9", 1]]);
    const r = timelinePage(trips, found, { searching: true, page: undefined });
    expect(r).toMatchObject({ page: 1, pages: 1 });
    expect(ids(r)).toEqual(["t3", "t9"]);
  });

  it("has nothing to show, on one page, when a search finds nothing", () => {
    expect(timelinePage(trips, new Map(), { searching: true, page: "3" })).toEqual({ onPage: [], page: 1, pages: 0 });
  });

  it("keeps the search, the order and the collection in the links to other pages", () => {
    const sp = { q: "dog", order: "oldest", collection: "best-of", person: ["a", "b"], page: "2" };
    const next = new URL(timelinePageHref(sp, 3), "http://album.test");
    expect(next.pathname).toBe("/timeline");
    expect(next.searchParams.get("q")).toBe("dog");
    expect(next.searchParams.get("order")).toBe("oldest");
    expect(next.searchParams.get("collection")).toBe("best-of");
    expect(next.searchParams.getAll("person")).toEqual(["a", "b"]);
    expect(next.searchParams.getAll("page")).toEqual(["3"]);
    // The first page is the plain address.
    expect(timelinePageHref(sp, 1)).toBe("/timeline?q=dog&order=oldest&collection=best-of&person=a&person=b");
    expect(timelinePageHref({ page: "2" }, 1)).toBe("/timeline");
  });
});
