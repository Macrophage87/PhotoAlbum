/**
 * Folding byte-identical photographs into one.
 *
 * The same file reaches the album twice more often than one would think: uploaded from a phone and again from the
 * laptop it was copied to, sent round the family and put in by two people, or picked up by a Takeout import beside
 * the upload it already had. They are not similar photographs — they are the same file, the same bytes, and the
 * album has no business showing them twice.
 *
 * Which is kept hardly matters; what matters is that nothing anyone wrote is lost when the others go. A copy may
 * carry the caption, the place or the date that the one being kept never had, so everything the keeper is missing
 * is taken from its copies before they go to the trash — and to the trash rather than deleted outright, so a family
 * that disagrees with the album's arithmetic can get them back.
 */

/** What a fold needs to know about either side. */
export type FoldablePhoto = {
  id: string;
  caption: string | null;
  title: string | null;
  context: string | null;
  takenAt: Date | null;
  takenAtSource: string | null;
  lat: number | null;
  lng: number | null;
  placeName: string | null;
  gpsSource: string | null;
  tripId: string | null;
  activityId: string | null;
  createdAt: Date;
};

/** A date the album guessed rather than read off the photograph; a copy that knows better is worth taking. */
const WEAK_DATE = ["FILE_MTIME", "UPLOAD_TIME", "FILE_NAME", "EXIF_CREATED"];
/** Likewise a place the album worked out for itself. */
const WEAK_PLACE = ["TRACK", "ESTIMATE", "SIDECAR"];

export type FoldPlan = { data: Record<string, unknown>; filled: string[] };

/**
 * What the keeper should take from one of its copies. Only what the keeper is missing, or holds on weaker grounds
 * than the copy does — nothing a member wrote on the keeper is ever written over.
 */
export function planFold(keeper: FoldablePhoto, copy: FoldablePhoto): FoldPlan {
  const data: Record<string, unknown> = {};
  const filled: string[] = [];

  if (!keeper.caption?.trim() && copy.caption?.trim()) {
    data.caption = copy.caption;
    filled.push("caption");
  }
  if (!keeper.title?.trim() && copy.title?.trim()) {
    data.title = copy.title;
    filled.push("title");
  }
  if (!keeper.context?.trim() && copy.context?.trim()) {
    data.context = copy.context;
    data.contextUpdatedAt = new Date();
    filled.push("notes");
  }

  const keeperDateIsWeak = keeper.takenAt === null || keeper.takenAtSource === null || WEAK_DATE.includes(keeper.takenAtSource);
  const copyDateIsBetter = copy.takenAt !== null && copy.takenAtSource !== null && !WEAK_DATE.includes(copy.takenAtSource);
  if (keeperDateIsWeak && copyDateIsBetter) {
    data.takenAt = copy.takenAt;
    data.takenAtSource = copy.takenAtSource;
    filled.push("date");
  }

  const keeperHasPlace = keeper.lat !== null && keeper.lng !== null;
  const keeperPlaceIsWeak = !keeperHasPlace || keeper.gpsSource === null || WEAK_PLACE.includes(keeper.gpsSource);
  const copyHasPlace = copy.lat !== null && copy.lng !== null;
  const copyPlaceIsBetter = copyHasPlace && copy.gpsSource !== null && !WEAK_PLACE.includes(copy.gpsSource);
  if (keeperPlaceIsWeak && copyPlaceIsBetter) {
    data.lat = copy.lat;
    data.lng = copy.lng;
    data.gpsSource = copy.gpsSource;
    data.placeName = copy.placeName;
    filled.push("place");
  } else if (!keeper.placeName?.trim() && copy.placeName?.trim() && keeperHasPlace === copyHasPlace) {
    data.placeName = copy.placeName;
    filled.push("place name");
  }

  // A copy that was filed on a trip tells the album where the photograph belongs, when the keeper is filed nowhere.
  if (!keeper.tripId && copy.tripId) {
    data.tripId = copy.tripId;
    data.activityId = copy.activityId;
    filled.push("trip");
  }

  return { data, filled };
}

/** Which of a group of identical files to keep: the one that has been in the album longest. */
export function keeperOf<T extends { createdAt: Date; id: string }>(group: T[]): T {
  return [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
}

export function describeFold(count: number, filled: string[]): string {
  const what = filled.length ? `, keeping the ${filled.join(", ")} from ${filled.length === 1 ? "it" : "them"}` : "";
  return `${count} identical ${count === 1 ? "copy" : "copies"} folded in${what}.`;
}
