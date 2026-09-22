import { describe, expect, it } from "vitest";
import { cosine, scoreCandidate, suggest, words, type Candidate, type Item } from "@/lib/suggest/score";

const acadia: Candidate = { kind: "trip", id: "t1", title: "Acadia", startDay: "2025-08-10", endDay: "2025-08-16", timezone: "America/New_York", points: [{ lat: 44.35, lng: -68.2 }], landmarks: [{ lat: 44.32, lng: -68.19, title: "Ocean Path hike" }] };
const lake: Candidate = { kind: "trip", id: "t2", title: "Lake House 2019", startDay: "2019-07-01", endDay: "2019-07-08", timezone: "UTC", points: [], landmarks: [] };
const favourites: Candidate = { kind: "collection", id: "c1", title: "Summer favorites", description: "the best of the beach and the boat", tags: new Set(["boat", "beach"]), peopleIds: new Set(["p1"]), centroid: [1, 0, 0], itemCount: 5 };
const item = (over: Partial<Item> = {}): Item => ({ id: "x", day: "2025-08-12", lat: 44.33, lng: -68.19, tags: new Set(["boat", "lobster"]), text: "lunch on the boat", peopleIds: new Set(), embedding: null, tripId: null, collectionIds: new Set(), ...over });

describe("suggestion scoring", () => {
  it("prefers the trip whose dates and places match, with readable reasons", () => {
    const s = scoreCandidate(item(), acadia)!;
    expect(s.score).toBeGreaterThan(0.9);
    expect(s.reasons).toEqual(["taken during the trip", expect.stringMatching(/km from the Ocean Path hike|m from the Ocean Path hike/)]);
    expect(scoreCandidate(item(), lake)).toBeNull();
  });
  it("gives partial credit near the dates and skips the trip the item is already on", () => {
    expect(scoreCandidate(item({ day: "2025-08-17", lat: null, lng: null }), acadia)?.reasons).toEqual(["the day after the trip"]);
    expect(scoreCandidate(item({ tripId: "t1" }), acadia)).toBeNull();
  });
  it("scores collections by words, people and embedding similarity", () => {
    const s = scoreCandidate(item({ peopleIds: new Set(["p1"]), embedding: [0.9, 0.1, 0] }), favourites)!;
    expect(s.reasons).toEqual([expect.stringMatching(/^mentions boat/), "the same person appears", "looks like the photos already in it"]);
    expect(scoreCandidate(item({ tags: new Set(), text: "", embedding: [0, 1, 0] }), favourites)).toBeNull();
    expect(scoreCandidate(item({ collectionIds: new Set(["c1"]) }), favourites)).toBeNull();
  });
  it("returns the top three, best first", () => {
    const many = [acadia, lake, favourites, { ...favourites, id: "c2", title: "Boats" }];
    const out = suggest(item(), many);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0].id).toBe("t1");
  });
  it("helpers", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect([...words("The Best of the Beach and the boat")]).toEqual(["best", "beach", "boat"]);
  });
});
