import { describe, expect, it } from "vitest";
import { keeperOf, planFold, type FoldablePhoto } from "@/lib/photos/fold-duplicates";

const photo = (over: Partial<FoldablePhoto> = {}): FoldablePhoto => ({
  id: "a", caption: null, title: null, context: null, takenAt: null, takenAtSource: null,
  lat: null, lng: null, placeName: null, gpsSource: null, tripId: null, activityId: null,
  createdAt: new Date("2025-01-01"), ...over,
});

/**
 * The same file twice is one photograph, and folding must not lose a word of what anybody wrote on either of them.
 * What the keeper already has is never written over; what it lacks is taken from the copy.
 */
describe("folding one identical copy into another", () => {
  it("takes the caption, title and notes the keeper never had", () => {
    const plan = planFold(photo(), photo({ id: "b", caption: "Biscuit in the kayak", title: "Kayaking", context: "Down the creek at low tide" }));
    expect(plan.data).toMatchObject({ caption: "Biscuit in the kayak", title: "Kayaking", context: "Down the creek at low tide" });
    expect(plan.filled).toEqual(["caption", "title", "notes"]);
  });

  it("never writes over what somebody put on the one being kept", () => {
    const keeper = photo({ caption: "Mine", title: "Mine", context: "Mine" });
    const plan = planFold(keeper, photo({ id: "b", caption: "Theirs", title: "Theirs", context: "Theirs" }));
    expect(plan.data).toEqual({});
    expect(plan.filled).toEqual([]);
  });

  it("takes a date the camera recorded over one the album guessed from the file", () => {
    const guessed = photo({ takenAt: new Date("2025-06-01"), takenAtSource: "FILE_MTIME" });
    const real = photo({ id: "b", takenAt: new Date("2019-08-12"), takenAtSource: "EXIF_OFFSET" });
    expect(planFold(guessed, real).data).toMatchObject({ takenAt: real.takenAt, takenAtSource: "EXIF_OFFSET" });
    // And not the other way round: a guess never displaces what the camera said.
    expect(planFold(real, guessed).data).toEqual({});
  });

  it("takes a place somebody set over one worked out from a track", () => {
    const fromTrack = photo({ lat: 1, lng: 2, gpsSource: "TRACK" });
    const byHand = photo({ id: "b", lat: 44.2223, lng: -68.3372, gpsSource: "MANUAL", placeName: "Bass Harbor Head Light" });
    expect(planFold(fromTrack, byHand).data).toMatchObject({ lat: 44.2223, lng: -68.3372, gpsSource: "MANUAL", placeName: "Bass Harbor Head Light" });
    expect(planFold(byHand, fromTrack).data).toEqual({});
  });

  it("takes the name of a place when both are pinned to the same kind of spot and only one is named", () => {
    const unnamed = photo({ lat: 1, lng: 2, gpsSource: "EXIF" });
    const named = photo({ id: "b", lat: 1, lng: 2, gpsSource: "EXIF", placeName: "The lake house" });
    expect(planFold(unnamed, named).data).toEqual({ placeName: "The lake house" });
  });

  it("takes the trip a copy was filed on when the keeper is filed nowhere, with its activity", () => {
    const plan = planFold(photo(), photo({ id: "b", tripId: "t1", activityId: "a1" }));
    expect(plan.data).toMatchObject({ tripId: "t1", activityId: "a1" });
    expect(planFold(photo({ tripId: "t2" }), photo({ id: "b", tripId: "t1" })).data).toEqual({});
  });

  it("keeps whichever has been in the album longest, settling a tie by id so it is never arbitrary", () => {
    const old = photo({ id: "old", createdAt: new Date("2024-01-01") });
    const recent = photo({ id: "new", createdAt: new Date("2026-01-01") });
    expect(keeperOf([recent, old]).id).toBe("old");
    const sameMoment = [photo({ id: "b" }), photo({ id: "a" })];
    expect(keeperOf(sameMoment).id).toBe("a");
    expect(keeperOf(sameMoment).id).toBe(keeperOf([...sameMoment].reverse()).id);
  });
});
