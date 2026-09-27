import { db } from "@/lib/db";
import type { NameCheck } from "@/generated/prisma/enums";

export type { NameCheck };

/**
 * How names are checked before words are shown to everyone (the share guard, namesSomebodyRestricted, and every
 * judgement that publishes the helper's words by itself).
 *
 * STRICT, the default: any mention of somebody who may not be named holds the words (strict-names.ts). RELAXED: the
 * same, with a closed list of excuses for a child's name read as an everyday word, a month or season, or a place
 * (relaxed-names.ts). Relaxed only ever applies to somebody restricted for being a child and nothing else: anybody who
 * opted out, is waiting to be forgotten, had their naming withdrawn, or was decided not to be named is matched strictly
 * whatever the level (restricted.ts), and a withdrawn naming's own check is strict always (withoutWithdrawnNames).
 *
 * The album has one level (AppSetting.nameCheck, an admin's) and a trip may override it (Trip.nameCheck, whoever
 * arranges the trip). Collections and activities have none of their own: a collection gathers photographs from many
 * trips and is shown under the album's level; an activity is its trip's. Words are shown wherever their item is, so an
 * item's words are checked at the strictest level of the places strangers may see it (see `photoNameCheck`).
 */
export const NAME_CHECKS = ["STRICT", "RELAXED"] as const satisfies readonly NameCheck[];

/** The stricter of these; STRICT when there are none. */
export function strictest(levels: (NameCheck | null | undefined)[]): NameCheck {
  const known = levels.filter((l): l is NameCheck => l === "STRICT" || l === "RELAXED");
  return known.length && known.every((l) => l === "RELAXED") ? "RELAXED" : "STRICT";
}

/** The album's level. */
export async function albumNameCheck(): Promise<NameCheck> {
  const s = await db.appSetting.findUnique({ where: { id: "app" }, select: { nameCheck: true } });
  return s?.nameCheck ?? "STRICT";
}

/** A trip's level: its own, else the album's. */
export function tripNameCheck(trip: { nameCheck: NameCheck | null } | null | undefined, album: NameCheck): NameCheck {
  return trip?.nameCheck ?? album;
}

/** The level for a trip's words (its description, its activities'). */
export async function nameCheckForTrip(tripId: string): Promise<NameCheck> {
  const [trip, album] = await Promise.all([db.trip.findUnique({ where: { id: tripId }, select: { nameCheck: true } }), albumNameCheck()]);
  return tripNameCheck(trip, album);
}

/** The level for a trip's or a collection's own words: a collection is shown under the album's. */
export async function nameCheckForContainer(kind: "trip" | "collection" | "activity", id: string): Promise<NameCheck> {
  if (kind === "trip") return nameCheckForTrip(id);
  if (kind === "activity") {
    const a = await db.activity.findUnique({ where: { id }, select: { tripId: true } });
    return a ? nameCheckForTrip(a.tripId) : "STRICT";
  }
  return albumNameCheck();
}

/** Where an item is, as far as its level goes. */
export type Placed = { trip: { nameCheck: NameCheck | null } | null; collections: { collection: { visibility: string } }[] };

/**
 * An item's level: its trip's (else the album's), and where it is also in a collection anybody outside the family can
 * open (public, or by link), the album's too, whichever is stricter. A private collection shows it to nobody new.
 */
export function photoNameCheck(p: Placed, album: NameCheck): NameCheck {
  const shared = p.collections.some(({ collection }) => collection.visibility !== "PRIVATE");
  return strictest([tripNameCheck(p.trip, album), ...(shared ? [album] : [])]);
}

/** Select for `photoNameCheck`. */
export const PLACED_SELECT = { trip: { select: { nameCheck: true } }, collections: { select: { collection: { select: { visibility: true } } } } } as const;

/** The level for an item's words; STRICT for one that is gone. */
export async function nameCheckForPhoto(photoId: string): Promise<NameCheck> {
  const [p, album] = await Promise.all([db.photo.findUnique({ where: { id: photoId }, select: PLACED_SELECT }), albumNameCheck()]);
  return p ? photoNameCheck(p, album) : "STRICT";
}

/** Whether anything in the album is checked RELAXED now: the album, or any trip. */
export async function anyRelaxed(): Promise<boolean> {
  if ((await albumNameCheck()) === "RELAXED") return true;
  return (await db.trip.count({ where: { nameCheck: "RELAXED" } })) > 0;
}
