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
  /** Who pinned the place, or — with no position — who removed it. */
  placeSetById: string | null;
  tripId: string | null;
  activityId: string | null;
  activitySetById: string | null;
  createdAt: Date;
};

/** A date the album guessed rather than read off the photograph; a copy that knows better is worth taking. */
const WEAK_DATE = ["FILE_MTIME", "UPLOAD_TIME", "FILE_NAME", "EXIF_CREATED"];
/** Likewise a place the album worked out for itself. */
const WEAK_PLACE = ["TRACK", "ESTIMATE", "SIDECAR"];

/** `conflict`: the copy's place was removed by hand while the keeper's was pinned by hand; the pin stays. */
export type FoldPlan = { data: Record<string, unknown>; filled: string[]; conflict?: "place" };

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
  // A place somebody removed by hand is never filled on the keeper, and a copy that had its place removed takes the
  // keeper's away too, with who removed it — it is the same photograph. Unless the keeper's place was pinned by
  // hand as well: two members disagree, the pin stays, and the report says so for somebody to look at.
  const keeperCleared = !keeperHasPlace && keeper.placeSetById !== null;
  const copyCleared = !copyHasPlace && copy.placeSetById !== null;
  let conflict: FoldPlan["conflict"];
  if (keeperCleared) {
    // Nothing to take.
  } else if (copyCleared && keeper.gpsSource === "MANUAL") {
    conflict = "place";
  } else if (copyCleared) {
    Object.assign(data, { lat: null, lng: null, altitude: null, gpsSource: null, placeName: null, placeSetById: copy.placeSetById });
    filled.push("place removed");
  } else if (keeperPlaceIsWeak && copyPlaceIsBetter) {
    data.lat = copy.lat;
    data.lng = copy.lng;
    data.gpsSource = copy.gpsSource;
    data.placeName = copy.placeName;
    // A pin a member put on the copy is still theirs on the keeper.
    data.placeSetById = copy.gpsSource === "MANUAL" ? copy.placeSetById : null;
    filled.push("place");
  } else if (!keeper.placeName?.trim() && copy.placeName?.trim() && keeperHasPlace === copyHasPlace) {
    data.placeName = copy.placeName;
    filled.push("place name");
  }

  // A copy that was filed on a trip tells the album where the photograph belongs, when the keeper is filed nowhere.
  if (!keeper.tripId && copy.tripId) {
    data.tripId = copy.tripId;
    data.activityId = copy.activityId;
    // Whoever chose the copy's activity (or kept it off them all) chose it for this photograph.
    data.activitySetById = copy.activitySetById;
    filled.push("trip");
  }

  return { data, filled, ...(conflict ? { conflict } : {}) };
}

/** Which of a group of identical files to keep: the one that has been in the album longest. */
export function keeperOf<T extends { createdAt: Date; id: string }>(group: T[]): T {
  return [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
}

export function describeFold(count: number, filled: string[]): string {
  const kept = filled.filter((f) => f !== "place removed");
  const what = kept.length ? `, keeping the ${kept.join(", ")} from ${count === 1 ? "it" : "them"}` : "";
  const removed = filled.includes("place removed") ? `${kept.length ? " and" : ","} with the place removed` : "";
  return `${count} identical ${count === 1 ? "copy" : "copies"} folded in${what}${removed}.`;
}
