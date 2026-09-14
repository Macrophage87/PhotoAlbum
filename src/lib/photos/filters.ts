import type { MediaKind } from "@/generated/prisma/enums";

/**
 * Narrowing a gallery down to what somebody is actually looking for.
 *
 * A trip from a fortnight away is a thousand photographs, and scrolling is a poor way to find the one with the
 * lighthouse in it. These are the questions worth asking of a gallery — what it says, who took it, what kind of
 * thing it is, which year, which part of the trip — and they are read from the address bar, so a narrowed gallery
 * is a link somebody can keep or send.
 */
export type GalleryFilter = {
  /** Words to look for: the same index the search page uses, plus the file's own name. */
  q: string | null;
  uploaderId: string | null;
  kind: MediaKind | null;
  year: number | null;
  activityId: string | null;
};

export const NO_FILTER: GalleryFilter = { q: null, uploaderId: null, kind: null, year: null, activityId: null };

const KINDS: MediaKind[] = ["PHOTO", "VIDEO", "EXTERNAL_VIDEO", "SCAN"];

/** What each kind is called where a member has to choose one. */
export const KIND_LABELS: Record<MediaKind, string> = {
  PHOTO: "Photographs",
  VIDEO: "Clips",
  EXTERNAL_VIDEO: "YouTube videos",
  SCAN: "3D scans",
};

/** The longest search worth sending; matches the search page. */
export const MAX_GALLERY_QUERY = 200;
const FIRST_PHOTOGRAPH = 1826;

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = typeof s === "string" ? s.trim() : "";
  return t ? t : null;
};

/**
 * Read a filter off the address bar. `member` is false for anonymous visitors, who never see the list of who
 * uploaded what and must not be able to filter by it either.
 */
export function parseGalleryFilter(sp: Params, opts: { member: boolean }): GalleryFilter {
  const rawQ = one(sp.q);
  const kind = one(sp.kind);
  const year = Number(one(sp.year));
  return {
    q: rawQ ? rawQ.replace(/\s+/g, " ").slice(0, MAX_GALLERY_QUERY) : null,
    uploaderId: opts.member ? one(sp.uploader) : null,
    kind: kind && (KINDS as string[]).includes(kind) ? (kind as MediaKind) : null,
    year: Number.isInteger(year) && year >= FIRST_PHOTOGRAPH && year <= 2200 ? year : null,
    activityId: one(sp.activity),
  };
}

export function filterIsActive(f: GalleryFilter): boolean {
  return Boolean(f.q || f.uploaderId || f.kind || f.year || f.activityId);
}

/** The filter as it goes back into a URL, so paging through a narrowed gallery keeps the narrowing. */
export function filterQuery(f: GalleryFilter): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.uploaderId) p.set("uploader", f.uploaderId);
  if (f.kind) p.set("kind", f.kind);
  if (f.year) p.set("year", String(f.year));
  if (f.activityId) p.set("activity", f.activityId);
  return p.toString();
}

/** What the gallery heading says once a filter is on, so a short list never looks like a lost library. */
export function describeCount(shown: number, total: number, active: boolean): string {
  if (!active) return `${total} ${total === 1 ? "item" : "items"}`;
  if (shown === 0) return `Nothing matches`;
  return `${shown} of ${total} ${total === 1 ? "item" : "items"}`;
}
