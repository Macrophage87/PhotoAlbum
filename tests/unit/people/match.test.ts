import { describe, expect, it } from "vitest";
import { ADULT_THRESHOLD, CHILD_THRESHOLD, ageAtCapture, bandAllows, boxIou, chooseEraCluster, pickMatch, thresholdFor, vetoes, widenedBand } from "@/lib/people/match";
import { namesMentioned } from "@/lib/people/text";

const born = new Date("1990-06-01T00:00:00Z");

describe("age at capture", () => {
  it("prefers the real date, then the estimate, then the model's guess", () => {
    const known = ageAtCapture(born, new Date("2020-06-01T00:00:00Z"), new Date("1995-01-01"), 40)!;
    expect(known.basis).toBe("known");
    expect(known.years).toBeCloseTo(30, 1);
    expect(ageAtCapture(born, null, new Date("1995-06-01T00:00:00Z"), 40)).toMatchObject({ basis: "estimated" });
    expect(ageAtCapture(born, null, null, 40)).toEqual({ years: 40, basis: "model" });
    expect(ageAtCapture(null, null, null, null)).toBeNull();
  });
});

describe("age-band selection", () => {
  const era = { ageBandMin: 4, ageBandMax: 8 };
  it("allows a face within the padded band, tighter for a known date than an estimate", () => {
    expect(bandAllows(era, { years: 11, basis: "known" })).toBe(true);
    expect(bandAllows(era, { years: 13, basis: "known" })).toBe(false);
    expect(bandAllows(era, { years: 15, basis: "estimated" })).toBe(true);
    expect(bandAllows(era, { years: 30, basis: "estimated" })).toBe(false);
  });
  it("bandless clusters and ageless faces always qualify", () => {
    expect(bandAllows({ ageBandMin: null, ageBandMax: null }, { years: 50, basis: "known" })).toBe(true);
    expect(bandAllows(era, null)).toBe(true);
  });
});

describe("threshold selection", () => {
  it("is stricter for children and for unknown ages", () => {
    expect(thresholdFor({ years: 35, basis: "known" })).toBe(ADULT_THRESHOLD);
    expect(thresholdFor({ years: 6, basis: "estimated" })).toBe(CHILD_THRESHOLD);
    expect(thresholdFor(null)).toBeGreaterThan(ADULT_THRESHOLD);
  });
  it("picks the most similar allowed candidate and marks childhood matches", () => {
    const cands = [
      { id: "a", personId: "sam", ageBandMin: 4, ageBandMax: 8, similarity: 0.75 },
      { id: "b", personId: "kate", ageBandMin: 4, ageBandMax: 8, similarity: 0.8 },
      { id: "c", personId: "jo", ageBandMin: 60, ageBandMax: 70, similarity: 0.9 },
    ];
    expect(pickMatch(cands, { years: 6, basis: "known" }, [])).toMatchObject({ personId: "kate", childhood: true });
    expect(pickMatch(cands, { years: 6, basis: "known" }, ["kate"])).toMatchObject({ personId: "sam" });
    expect(pickMatch(cands.map((c) => ({ ...c, similarity: 0.65 })), { years: 6, basis: "known" }, [])).toBeNull();
    expect(pickMatch(cands.map((c) => ({ ...c, similarity: 0.65 })), { years: 30, basis: "known" }, [])).toBeNull();
  });
  it("vetoes people from rejected faces that look like this one", () => {
    expect(vetoes([1, 0], [{ proposedPersonId: "x", embedding: [0.9, 0.1] }, { proposedPersonId: "y", embedding: [0, 1] }])).toEqual(["x"]);
  });
});

describe("era clusters and merging", () => {
  const eras = [
    { id: "child", ageBandMin: 3, ageBandMax: 9 },
    { id: "adult", ageBandMin: 28, ageBandMax: 35 },
  ];
  it("joins the covering era, the nearest era within reach, or none (a new era)", () => {
    expect(chooseEraCluster(eras, { years: 5, basis: "known" })?.id).toBe("child");
    expect(chooseEraCluster(eras, { years: 12, basis: "known" })?.id).toBe("child");
    expect(chooseEraCluster(eras, { years: 19, basis: "known" })).toBeNull();
    expect(chooseEraCluster(eras, { years: 37, basis: "estimated" })?.id).toBe("adult");
    expect(chooseEraCluster([], { years: 5, basis: "known" })).toBeNull();
    expect(chooseEraCluster([...eras, { id: "bandless", ageBandMin: null, ageBandMax: null }], { years: 19, basis: "known" })?.id).toBe("bandless");
  });
  it("widens the band to include the new face", () => {
    expect(widenedBand(eras[0], { years: 11.4, basis: "known" })).toEqual({ ageBandMin: 3, ageBandMax: 11 });
    expect(widenedBand({ ageBandMin: null, ageBandMax: null }, { years: 40, basis: "model" })).toEqual({ ageBandMin: 40, ageBandMax: 40 });
  });
  it("recognises the same box on a re-scan", () => {
    expect(boxIou([0.1, 0.1, 0.2, 0.2], [0.11, 0.1, 0.2, 0.2])).toBeGreaterThan(0.8);
    expect(boxIou([0.1, 0.1, 0.2, 0.2], [0.6, 0.6, 0.2, 0.2])).toBe(0);
  });
});

describe("text-to-name", () => {
  const people = [
    { id: "sam", name: "Sam" },
    { id: "jo", name: "Grandma Jo" },
    { id: "kate", name: "Kate Miller" },
    { id: "kate2", name: "Kate Jones" },
    { id: "al", name: "Al" },
  ];
  it("finds full names and distinctive first names as whole words", () => {
    expect(namesMentioned("Sam at age 4 with Grandma Jo", people).map((p) => p.id)).toEqual(["sam", "jo"]);
    expect(namesMentioned("Samantha's party", people)).toEqual([]);
    expect(namesMentioned("All of us", people)).toEqual([]);
  });
  it("ignores a first name shared by two people unless the full name is written", () => {
    expect(namesMentioned("Kate on the beach", people)).toEqual([]);
    expect(namesMentioned("Kate Jones on the beach", people).map((p) => p.id)).toEqual(["kate2"]);
  });
});
