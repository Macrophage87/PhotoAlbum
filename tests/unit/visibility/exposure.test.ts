import { describe, expect, it } from "vitest";
import { describeStillExposed, describeWidening, effectiveLevel, summarizeExposure, type ContainerRef, type ItemContainers } from "@/lib/visibility/exposure";

const trip = (visibility: ContainerRef["visibility"], id = "t1"): ContainerRef => ({ kind: "trip", id, title: "Lake House 2019", visibility });
const col = (visibility: ContainerRef["visibility"], id = "c1"): ContainerRef => ({ kind: "collection", id, title: "Summer Favorites", visibility });
const item = (t: ContainerRef | null, cs: ContainerRef[] = [], id = "p1"): ItemContainers => ({ id, trip: t, collections: cs });

describe("effective level is the union of containers", () => {
  it("takes the most visible container, members-only when there is none", () => {
    expect(effectiveLevel(item(null))).toBe(0);
    expect(effectiveLevel(item(trip("PRIVATE"), [col("LINK")]))).toBe(1);
    expect(effectiveLevel(item(trip("PRIVATE"), [col("PUBLIC")]))).toBe(2);
  });
});

describe("widening", () => {
  it("adding private-trip photos to a public collection exposes them", () => {
    const items = [item(trip("PRIVATE")), item(trip("PRIVATE"), [], "p2"), item(trip("PUBLIC", "t2"), [], "p3")];
    const s = summarizeExposure(items, { kind: "addToCollection", collection: col("PUBLIC") });
    expect(s.widened).toEqual([{ level: 2, count: 2, from: [trip("PRIVATE")] }]);
    expect(describeWidening(s, "through the collection Summer Favorites")[0]).toContain("2 of 3 photos from the private trip Lake House 2019 will become visible to anyone on the internet");
  });
  it("moving items with no container to a link-shared trip widens to the link level", () => {
    const s = summarizeExposure([item(null)], { kind: "moveToTrip", trip: trip("LINK") });
    expect(s.widened[0]).toMatchObject({ level: 1, count: 1 });
    expect(describeWidening(s, "")[0]).toContain("that only family members could see");
  });
  it("raising a collection to public widens its private items only", () => {
    const items = [item(trip("PRIVATE"), [col("PRIVATE")]), item(trip("PUBLIC", "t2"), [col("PRIVATE")], "p2")];
    const s = summarizeExposure(items, { kind: "setVisibility", container: { kind: "collection", id: "c1" }, visibility: "PUBLIC" });
    expect(s.widened).toEqual([{ level: 2, count: 1, from: [trip("PRIVATE"), col("PRIVATE")] }]);
  });
  it("reports nothing when the change exposes nothing new", () => {
    const s = summarizeExposure([item(trip("PUBLIC"))], { kind: "addToCollection", collection: col("LINK") });
    expect(s.widened).toEqual([]);
    expect(describeWidening(s, "x")).toEqual([]);
  });
});

describe("lowering does not shrink a union", () => {
  it("names the containers that still expose the items", () => {
    const items = [item(trip("PUBLIC"), [col("PUBLIC")]), item(trip("PUBLIC"), [], "p2")];
    const s = summarizeExposure(items, { kind: "setVisibility", container: { kind: "trip", id: "t1" }, visibility: "PRIVATE" });
    expect(s.widened).toEqual([]);
    expect(s.stillExposed).toEqual([{ level: 2, count: 1, via: [col("PUBLIC")] }]);
    expect(describeStillExposed(s, "this trip")[0]).toBe("1 of this trip's 2 photos is also in the public collection Summer Favorites and stays visible to anyone on the internet.");
  });
  it("is silent when lowering actually hides everything", () => {
    const s = summarizeExposure([item(trip("PUBLIC"), [col("PRIVATE")])], { kind: "setVisibility", container: { kind: "trip", id: "t1" }, visibility: "PRIVATE" });
    expect(s.stillExposed).toEqual([]);
  });
});
