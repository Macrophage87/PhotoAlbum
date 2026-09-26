/** A page of the timeline of everything holds at most this many trips… */
export const TIMELINE_PAGE_TRIPS = 5;
/** …and stops taking more once it has about this many photographs, so five big trips are not one enormous page. */
export const TIMELINE_PAGE_PHOTOS = 600;

/**
 * Where each page of the timeline of everything starts and ends, as [start, end) positions in the list of trips.
 *
 * The whole album used to be one page: every trip's timeline built at once, every photograph in it sent to the
 * browser, which at a few years of trips was tens of megabytes and seconds of waiting for anyone, signed in or not.
 * A page is now a handful of trips, cut earlier when they are big ones. A trip is never split across pages — its own
 * page shows it whole — so one trip larger than the budget is a page to itself.
 *
 * Worked out from the counts alone, so the same counts always give the same pages and a page number in an address
 * keeps meaning the same trips.
 */
export function timelinePages(counts: number[], limits: { trips: number; photos: number } = { trips: TIMELINE_PAGE_TRIPS, photos: TIMELINE_PAGE_PHOTOS }): { start: number; end: number }[] {
  const pages: { start: number; end: number }[] = [];
  let start = 0;
  let photos = 0;
  for (let i = 0; i < counts.length; i++) {
    const full = i - start >= limits.trips || (i > start && photos + counts[i] > limits.photos);
    if (full) {
      pages.push({ start, end: i });
      start = i;
      photos = 0;
    }
    photos += counts[i];
  }
  if (start < counts.length) pages.push({ start, end: counts.length });
  return pages;
}

/** The page asked for in the address, kept within the pages there are. */
export function pageNumber(value: unknown, pages: number): number {
  const n = Math.floor(Number(Array.isArray(value) ? value[0] : value));
  return Math.min(Math.max(1, Number.isFinite(n) ? n : 1), Math.max(1, pages));
}

/**
 * The trips on the page asked for, and how many pages there are. A search across everything is a short answer from
 * a few trips, so the ones with nothing in them drop out before the pages are cut, and no page is left empty.
 */
export function timelinePage<T extends { id: string }>(trips: T[], counts: Map<string, number>, opts: { searching: boolean; page: unknown }): { onPage: T[]; page: number; pages: number } {
  const candidates = opts.searching ? trips.filter((t) => (counts.get(t.id) ?? 0) > 0) : trips;
  const pages = timelinePages(candidates.map((t) => counts.get(t.id) ?? 0));
  const page = pageNumber(opts.page, pages.length);
  const onPage = pages.length ? candidates.slice(pages[page - 1].start, pages[page - 1].end) : [];
  return { onPage, page, pages: pages.length };
}

/** The same address a page further on: the search, the order and the collection all stay as they were. */
export function timelinePageHref(sp: Record<string, string | string[] | undefined>, page: number): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "page") for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) next.append(k, one);
  if (page > 1) next.set("page", String(page));
  const query = next.toString();
  return query ? `/timeline?${query}` : "/timeline";
}
