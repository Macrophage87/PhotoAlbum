import { describe, expect, it } from "vitest";
import { aliveAt, ANIMAL_MATCH_THRESHOLD, centroidOf, cosine, descriptorHit, matchAnimal, mentionsChickens, vetoedByRejections, type PetCandidate } from "@/lib/pets/matching";

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
  it("proposes the one flock of a species whenever that exact species is seen", () => {
    expect(matchAnimal({ species: "CHICKEN", embedding: unit(9), takenAt: null, rejectedPetIds: [] }, pets)).toMatchObject({ petId: "chickens" });
    expect(matchAnimal({ species: "CHICKEN", embedding: null, takenAt: null, rejectedPetIds: [] }, [...pets, { ...chickens, id: "other-flock" }])).toBeNull();
  });
  it("builds a unit centroid", () => {
    const c = centroidOf([unit(1), unit(1)])!;
    expect(cosine(c, unit(1))).toBeCloseTo(1, 6);
    expect(centroidOf([])).toBeNull();
  });
});

/** A unit vector at exactly cosine `c` from axis 0 (and orthogonal to axes 2+), so scores are known in advance. */
const at = (c: number, dim = 8, other = 1) => {
  const v = new Array<number>(dim).fill(0);
  v[0] = c;
  v[other] = Math.sqrt(1 - c * c);
  return v;
};
const axis = (i: number, dim = 8) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
const dog = (id: string, centroid: number[] | null, extra: Partial<PetCandidate> = {}): PetCandidate => ({ id, species: "DOG", isFlock: false, livedFrom: null, livedTo: null, centroid, ...extra });
const seen = (embedding: number[] | null, extra: Partial<Parameters<typeof matchAnimal>[0]> = {}) => ({ species: "DOG", embedding, takenAt: null, rejectedPetIds: [], ...extra });

describe("pet matching: threshold and several pets", () => {
  it("proposes at exactly the 0.82 threshold and not just below it", () => {
    expect(ANIMAL_MATCH_THRESHOLD).toBe(0.82);
    const only = [dog("a", axis(0))];
    expect(matchAnimal(seen(at(0.82)), only)).toMatchObject({ petId: "a" });
    expect(matchAnimal(seen(at(0.8199)), only)).toBeNull();
  });
  it("proposes the best of several pets that clear the threshold, whatever their order", () => {
    const a = dog("a", at(0.85, 8, 1));
    const b = dog("b", at(0.95, 8, 2));
    const c = dog("c", at(0.9, 8, 3));
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) expect(matchAnimal(seen(axis(0)), order)).toMatchObject({ petId: "b" });
    expect(matchAnimal(seen(axis(0)), [a, b, c])!.score).toBeCloseTo(0.95, 6);
  });
});

describe("pet matching: a no counts against the pet (#22)", () => {
  it("skips a pet whose rejected crop is closer than its confirmed ones, on any photo", () => {
    const biscuitNo = dog("biscuit", axis(0), { rejected: [at(0.99, 8, 1)] });
    // The crop is 0.9 like Biscuit's confirmed crops but almost identical to a crop a member said was not Biscuit.
    const crop = at(0.9, 8, 1);
    expect(vetoedByRejections(crop, biscuitNo)).toBe(true);
    expect(matchAnimal(seen(crop), [biscuitNo])).toBeNull();
    // Without the rejection it would have been proposed.
    expect(matchAnimal(seen(crop), [dog("biscuit", axis(0))])).toMatchObject({ petId: "biscuit" });
    // A second look-alike is proposed instead of the vetoed one.
    expect(matchAnimal(seen(crop), [biscuitNo, dog("rex", at(0.85, 8, 1))])).toMatchObject({ petId: "rex" });
  });
  it("does not veto when the rejected crop is further away than the confirmed ones, or not alike at all", () => {
    expect(matchAnimal(seen(axis(0)), [dog("biscuit", axis(0), { rejected: [at(0.9, 8, 1)] })])).toMatchObject({ petId: "biscuit" });
    // A rejected crop of quite a different animal says nothing about this one.
    expect(vetoedByRejections(at(0.5, 8, 1), dog("biscuit", axis(0), { rejected: [at(0.6, 8, 2)] }))).toBe(false);
  });
  it("also stops a flock from being proposed for a crop just like one rejected for it", () => {
    const flock: PetCandidate = { id: "chickens", species: "CHICKEN", isFlock: true, livedFrom: null, livedTo: null, centroid: null, rejected: [axis(3)] };
    expect(matchAnimal({ species: "CHICKEN", embedding: axis(3), takenAt: null, rejectedPetIds: [] }, [flock])).toBeNull();
    expect(matchAnimal({ species: "CHICKEN", embedding: axis(4), takenAt: null, rejectedPetIds: [] }, [flock])).toMatchObject({ petId: "chickens" });
  });
});

describe("pet matching: Looks like words (#11)", () => {
  it("matches descriptor words against the photo's words, ignoring generic animal words", () => {
    expect(descriptorHit("golden retriever, floppy ears", "a golden dog runs on the beach")).toBe(true);
    expect(descriptorHit("Black lab", "two black labs asleep")).toBe(true);
    expect(descriptorHit("small dog", "a dog in the snow")).toBe(false);
    expect(descriptorHit("golden retriever", undefined)).toBe(false);
    expect(descriptorHit(null, "a golden retriever")).toBe(false);
  });
  it("prefers the look-alike whose words appear when several clear the threshold", () => {
    const biscuit = dog("biscuit", at(0.86, 8, 1), { descriptors: "golden retriever" });
    const rex = dog("rex", at(0.95, 8, 2), { descriptors: "black lab" });
    expect(matchAnimal(seen(axis(0)), [biscuit, rex])).toMatchObject({ petId: "rex" });
    expect(matchAnimal(seen(axis(0), { text: "a golden retriever with a stick" }), [biscuit, rex])).toMatchObject({ petId: "biscuit" });
  });
  it("with no look-alike, proposes the one pet whose words appear, and nobody when two do or none do", () => {
    const biscuit = dog("biscuit", null, { descriptors: "golden retriever" });
    const rex = dog("rex", null, { descriptors: "black lab" });
    const max = dog("max", null, { descriptors: "golden doodle" });
    expect(matchAnimal(seen(axis(5), { text: "a black lab on the porch" }), [biscuit, rex, max])).toMatchObject({ petId: "rex", score: 0 });
    expect(matchAnimal(seen(axis(5), { text: "a golden dog on the porch" }), [biscuit, rex, max])).toBeNull();
    expect(matchAnimal(seen(axis(5), { text: "a dog on the porch" }), [biscuit, rex, max])).toBeNull();
    expect(matchAnimal(seen(axis(5)), [biscuit, rex, max])).toBeNull();
  });
});

describe("pet matching: birds are not automatically the chickens (#23)", () => {
  const flock: PetCandidate = { id: "chickens", species: "CHICKEN", isFlock: true, livedFrom: null, livedTo: null, centroid: null };
  const bird = (embedding: number[] | null, text?: string) => ({ species: "BIRD", embedding, takenAt: null, rejectedPetIds: [], text });
  it("does not propose the chickens for a bird when nothing says they are chickens", () => {
    expect(matchAnimal(bird(axis(0)), [flock])).toBeNull();
    expect(matchAnimal(bird(axis(0), "a seagull on the pier at the beach"), [flock])).toBeNull();
  });
  it("proposes the chickens for a bird when the photo's words mention them", () => {
    expect(matchAnimal(bird(axis(0), "the hens scratching in the yard"), [flock])).toMatchObject({ petId: "chickens" });
    expect(matchAnimal(bird(null, "kids by the chicken coop"), [flock])).toMatchObject({ petId: "chickens" });
    expect(mentionsChickens("a rooster at dawn")).toBe(true);
    expect(mentionsChickens("chickpea salad")).toBe(false);
  });
  it("proposes the chickens for a bird that looks like the flock's confirmed crops, words or not", () => {
    expect(matchAnimal(bird(at(0.9)), [{ ...flock, centroid: axis(0) }])).toMatchObject({ petId: "chickens" });
    expect(matchAnimal(bird(at(0.5)), [{ ...flock, centroid: axis(0) }])).toBeNull();
  });
  it("still proposes the chickens for a detection already called a chicken, and a bird pet for any bird", () => {
    expect(matchAnimal({ species: "CHICKEN", embedding: null, takenAt: null, rejectedPetIds: [] }, [flock])).toMatchObject({ petId: "chickens" });
    const parrots: PetCandidate = { id: "parrots", species: "BIRD", isFlock: true, livedFrom: null, livedTo: null, centroid: null };
    expect(matchAnimal(bird(axis(0)), [flock, parrots])).toMatchObject({ petId: "parrots" });
  });
});
