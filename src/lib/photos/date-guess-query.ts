import { db } from "@/lib/db";
import { guessDate, isWeakDate, TRUSTED_DATE_SOURCES, type DateGuess, type Neighbour } from "./date-from-neighbours";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { NOT_TRASHED } from "./trash";

/** How many look-alikes to ask about; the most similar few say far more than a long tail. */
const SIMILAR = 5;

/**
 * Work out when one item was taken from the rest of its trip. Returns null for an item that already has a date worth
 * keeping, for one filed under no trip, or when the trip holds nothing dated to reason from.
 */
export async function guessDateFromTrip(photoId: string): Promise<DateGuess | null> {
  const photo = await db.photo.findUnique({
    where: { id: photoId },
    select: { id: true, originalName: true, takenAt: true, takenAtSource: true, tripId: true, trip: { select: { startDate: true, endDate: true, timezone: true } } },
  });
  if (!photo || !photo.tripId || !photo.trip) return null;
  if (!isWeakDate(photo.takenAtSource, photo.takenAt)) return null;

  const dated = await db.photo.findMany({
    where: { tripId: photo.tripId, ...NOT_TRASHED, id: { not: photo.id }, takenAt: { not: null }, takenAtSource: { in: TRUSTED_DATE_SOURCES } },
    select: { id: true, originalName: true, takenAt: true, tzOffsetMin: true },
    orderBy: { takenAt: "asc" },
  });
  const neighbours: Neighbour[] = dated.map((d) => ({ id: d.id, originalName: d.originalName, takenAt: d.takenAt!, tzOffsetMin: d.tzOffsetMin }));

  const links = await db.mediaSimilarity.findMany({
    where: { OR: [{ photoAId: photo.id }, { photoBId: photo.id }] },
    orderBy: { score: "desc" },
    take: SIMILAR * 4,
    select: { photoAId: true, photoBId: true },
  });
  const similarIds = links.map((l) => (l.photoAId === photo.id ? l.photoBId : l.photoAId)).slice(0, SIMILAR);

  const midpoint = new Date((photo.trip.startDate.getTime() + photo.trip.endDate.getTime()) / 2);
  return guessDate({ id: photo.id, originalName: photo.originalName }, neighbours, {
    similarIds,
    trip: { startDate: photo.trip.startDate, endDate: photo.trip.endDate, tzOffsetMin: offsetMinutesInZone(midpoint, photo.trip.timezone) },
  });
}

/** Every item on a trip that has no date worth keeping, with what its neighbours say about it. */
export async function guessDatesForTrip(tripId: string): Promise<{ id: string; originalName: string; guess: DateGuess }[]> {
  const weak = await db.photo.findMany({
    where: { tripId, ...NOT_TRASHED, status: "READY", OR: [{ takenAt: null }, { takenAtSource: null }, { takenAtSource: { in: ["FILE_MTIME", "UPLOAD_TIME", "EXIF_CREATED"] } }] },
    select: { id: true, originalName: true },
    orderBy: { originalName: "asc" },
  });
  const out: { id: string; originalName: string; guess: DateGuess }[] = [];
  for (const p of weak) {
    const guess = await guessDateFromTrip(p.id);
    if (guess) out.push({ id: p.id, originalName: p.originalName, guess });
  }
  return out;
}
