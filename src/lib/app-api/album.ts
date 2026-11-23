import type { PhotoCard } from "@/lib/photos/queries";
import { fullSizeUrl, photoUrl } from "@/lib/photos/urls";
import { readableContainerDescription, readableTitle } from "@/lib/photos/readable-text";
import { dateColumnToDay, photoDay } from "@/lib/time/local-day";
import type { TripCardData } from "@/lib/trips/queries";
import type { CollectionCardData } from "@/lib/collections/queries";

/**
 * What the phone app is told about the album, for its browsing screens. Every address is a path on the album's own
 * server, for the app to put its address in front of; the picture routes take the phone's token as they take a
 * browser's session. Only members reach these routes, so the words are a member's, and nothing here is ever
 * answered for a visitor.
 */

/** How many a page of a trip, a collection or the list of them holds. */
export const APP_PAGE = 100;

export type AppItem = {
  id: string;
  kind: PhotoCard["kind"];
  /** When it was taken, as an instant, and the day it was on where it was taken: the app shows the day. */
  takenAt: string | null;
  day: string | null;
  width: number | null;
  height: number | null;
  title: string | null;
  caption: string | null;
  place: string | null;
  lat: number | null;
  lng: number | null;
  durationS: number | null;
  thumb: string;
  medium: string;
  /** The picture as it is now, at full size. */
  full: string | null;
  /** A clip's playable copy; its still is `thumb` and `medium`. */
  video: string | null;
  /** A long video kept on YouTube: its id there, for the app to hand to YouTube. */
  youtubeId: string | null;
  /** The item's own page on the album's website. */
  page: string;
};

export function toAppItem(p: PhotoCard): AppItem {
  return {
    id: p.id,
    kind: p.kind,
    takenAt: p.takenAt?.toISOString() ?? null,
    day: p.takenAt ? photoDay(p.takenAt, p.tzOffsetMin, p.trip?.timezone ?? "UTC") : null,
    width: p.width,
    height: p.height,
    title: readableTitle(p, true),
    caption: p.caption?.trim() || null,
    place: p.placeName?.trim() || null,
    lat: p.lat,
    lng: p.lng,
    durationS: p.durationS,
    thumb: photoUrl(p, "thumb"),
    medium: photoUrl(p, "medium"),
    full: p.kind === "PHOTO" ? fullSizeUrl(p, true) : null,
    video: p.kind === "VIDEO" ? photoUrl(p, "video") : null,
    youtubeId: p.kind === "EXTERNAL_VIDEO" ? p.externalId : null,
    page: `/photos/${p.id}`,
  };
}

type Cover = { id: string; imageVersion: number } | null;

export function toAppTrip(t: TripCardData, cover: Cover) {
  return {
    id: t.id,
    slug: t.slug,
    title: t.title,
    description: readableContainerDescription(t, true),
    startDate: dateColumnToDay(t.startDate),
    endDate: dateColumnToDay(t.endDate),
    items: t._count.photos,
    cover: cover ? { thumb: photoUrl(cover, "thumb"), medium: photoUrl(cover, "medium") } : null,
    page: `/trips/${t.slug}`,
  };
}

export function toAppCollection(c: CollectionCardData, cover: Cover) {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    description: readableContainerDescription(c, true),
    items: c._count.items,
    cover: cover ? { thumb: photoUrl(cover, "thumb"), medium: photoUrl(cover, "medium") } : null,
    page: `/collections/${c.slug}`,
  };
}

/** A page number from the address, counting rows: anything that is not a whole number is the first page. */
export function pageOffset(raw: string | null): number {
  const n = Math.floor(Number(raw ?? 0));
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 2 ** 31 - 1) : 0;
}
