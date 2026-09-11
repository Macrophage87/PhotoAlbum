import { describe, expect, it } from "vitest";
import { aliveAt, centroidOf, cosine, matchAnimal, type PetCandidate } from "@/lib/pets/matching";

const unit = (seed: number, dim = 8) => {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * 7 + i * 1.3));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};
const biscuit: PetCandidate = { id: "biscuit", species: "DOG", isFlock: false, livedFrom: new Date("2016-05-01"), livedTo: null, centroid: unit(1) };
const rex: PetCandidate = { id: "rex", species: "DOG", isFlock: false, livedFrom: null, livedTo: new Date("2010-01-01"), centroid: unit(2) };
const chickens: PetCandidate = { id: "chickens", species: "CHICKEN", isFlock: true, livedFrom: null, livedTo: null, centroid: null };
const pets = [biscuit, rex, chickens];

describe("pet matching", () => {
  it("proposes the look-alike of the same species above the threshold", () => {
    expect(matchAnimal({ species: "DOG", embedding: unit(1), takenAt: new Date("2020-01-01"), rejectedPetIds: [] }, pets)).toMatchObject({ petId: "biscuit" });
    expect(matchAnimal({ species: "CAT", embedding: unit(1), takenAt: new Date("2020-01-01"), rejectedPetIds: [] }, pets)).toBeNull();
    expect(matchAnimal({ species: "DOG", embedding: unit(5), takenAt: new Date("2020-01-01"), rejectedPetIds: [] }, pets)).toBeNull();
  });
  it("never proposes a pet that was not with the family then, nor one already rejected on the photo", () => {
    expect(matchAnimal({ species: "DOG", embedding: unit(2), takenAt: new Date("2020-01-01"), rejectedPetIds: [] }, pets)).toBeNull();
    expect(matchAnimal({ species: "DOG", embedding: unit(2), takenAt: new Date("2009-06-01"), rejectedPetIds: [] }, pets)).toMatchObject({ petId: "rex" });
    expect(matchAnimal({ species: "DOG", embedding: unit(1), takenAt: null, rejectedPetIds: ["biscuit"] }, pets)).toBeNull();
    expect(aliveAt(biscuit, new Date("2016-04-15"))).toBe(true);
    expect(aliveAt(biscuit, new Date("2015-01-01"))).toBe(false);
  });
  it("proposes the one flock of a species whenever that species is seen", () => {
    expect(matchAnimal({ species: "CHICKEN", embedding: unit(9), takenAt: null, rejectedPetIds: [] }, pets)).toMatchObject({ petId: "chickens" });
    expect(matchAnimal({ species: "CHICKEN", embedding: null, takenAt: null, rejectedPetIds: [] }, [...pets, { ...chickens, id: "other-flock" }])).toBeNull();
  });
  it("builds a unit centroid", () => {
    const c = centroidOf([unit(1), unit(1)])!;
    expect(cosine(c, unit(1))).toBeCloseTo(1, 6);
    expect(centroidOf([])).toBeNull();
  });
});
