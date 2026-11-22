/**
 * Pure matching for animal detections: which pet, if any, is this crop probably?
 *
 * - The species must fit, and the pet must have been with the family when the photo was taken. A pet the member
 *   already said "no" to on this photo is never proposed there again.
 * - A pet whose rejected crops look more like this one than its confirmed crops do is not proposed: a "no" counts
 *   against that pet from then on, the way a rejected face does.
 * - Otherwise the best cosine similarity to a pet's confirmed crops must clear the threshold. When several pets clear
 *   it, one whose "Looks like" words appear in the photo's words wins over one whose do not.
 * - With no look-alike, a pet whose "Looks like" words appear in the photo's words is proposed when it is the only one
 *   of its kind that fits them, and a flock record ("the chickens") is proposed when it is the only flock of its kind.
 * - The detector cannot tell a hen from a gull, so a BIRD fits a chicken record only with evidence: the photo's words
 *   mention chickens, or the crop looks like the flock's confirmed crops.
 */
export const ANIMAL_MATCH_THRESHOLD = 0.82;

export type PetCandidate = {
  id: string;
  species: string | null;
  isFlock: boolean;
  livedFrom: Date | null;
  livedTo: Date | null;
  centroid: number[] | null;
  /** The pet's "Looks like" text, as typed ("golden retriever, floppy ears"). */
  descriptors?: string | null;
  /** Crops a member said were not this pet. */
  rejected?: number[][];
};
export type AnimalToMatch = {
  species: string;
  embedding: number[] | null;
  takenAt: Date | null;
  rejectedPetIds: string[];
  /** The photo's words, lowercased: the AI helper's caption, description and tags, and what members wrote. */
  text?: string;
};

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function aliveAt(pet: { livedFrom: Date | null; livedTo: Date | null }, when: Date | null): boolean {
  if (!when) return true;
  if (pet.livedFrom && when < new Date(pet.livedFrom.getTime() - 30 * 86_400_000)) return false;
  if (pet.livedTo && when > new Date(pet.livedTo.getTime() + 30 * 86_400_000)) return false;
  return true;
}

/** The detection species a pet of this species can be seen as. A chicken is detected as a bird. */
export function detectedAs(species: string): string[] {
  return species === "CHICKEN" ? ["CHICKEN", "BIRD"] : [species];
}

const CHICKEN_WORDS = /\b(chickens?|hens?|roosters?|cockerels?|pullets?|bantams?|chicks?|poultry|coops?|henhouses?)\b/;
export function mentionsChickens(text: string | undefined): boolean {
  return !!text && CHICKEN_WORDS.test(text.toLowerCase());
}

/** Words that say nothing about which animal it is: every dog photo says "dog". */
const NOT_DESCRIPTIVE = new Set(["and", "with", "the", "has", "very", "bit", "one", "two", "our", "her", "his", "dog", "dogs", "puppy", "cat", "cats", "kitten", "chicken", "chickens", "hen", "hens", "bird", "birds", "horse", "horses", "pony", "pet", "pets", "animal"]);

export function descriptorWords(descriptors: string | null | undefined): string[] {
  if (!descriptors) return [];
  return [...new Set(descriptors.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !NOT_DESCRIPTIVE.has(w)))];
}

/** Whether any of the pet's "Looks like" words is among the photo's words (a plain plural counts). */
export function descriptorHit(descriptors: string | null | undefined, text: string | undefined): boolean {
  const words = descriptorWords(descriptors);
  if (!words.length || !text) return false;
  const seen = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return words.some((w) => seen.has(w) || seen.has(`${w}s`) || seen.has(`${w}es`) || (w.endsWith("s") && seen.has(w.slice(0, -1))));
}

/**
 * A "no" counts against the pet: vetoed when one of its rejected crops looks like the same animal (clears the match
 * threshold) and is closer to this crop than the pet's confirmed crops are.
 */
export function vetoedByRejections(embedding: number[] | null, pet: PetCandidate, threshold = ANIMAL_MATCH_THRESHOLD): boolean {
  if (!embedding || !pet.rejected?.length) return false;
  const nearestNo = Math.max(...pet.rejected.map((r) => cosine(embedding, r)));
  const yes = pet.centroid ? cosine(embedding, pet.centroid) : 0;
  return nearestNo >= threshold && nearestNo > yes;
}

export function matchAnimal(animal: AnimalToMatch, pets: PetCandidate[], threshold = ANIMAL_MATCH_THRESHOLD): { petId: string; score: number } | null {
  const fits = pets.filter((p) => p.species && detectedAs(p.species).includes(animal.species) && !animal.rejectedPetIds.includes(p.id) && aliveAt(p, animal.takenAt));
  const scored = fits
    .filter((p) => !vetoedByRejections(animal.embedding, p, threshold))
    .map((p) => ({
      pet: p,
      score: animal.embedding && p.centroid ? cosine(animal.embedding, p.centroid) : null,
      hit: descriptorHit(p.descriptors, animal.text),
      // A bird detection is only a chicken with something else saying so.
      needsWords: animal.species !== p.species,
    }));

  const lookalikes = scored.filter((s) => s.score !== null && s.score >= threshold);
  if (lookalikes.length) {
    const described = lookalikes.filter((s) => s.hit);
    const pool = described.length ? described : lookalikes;
    const best = pool.reduce((a, b) => (b.score! > a.score! ? b : a));
    return { petId: best.pet.id, score: best.score! };
  }

  const open = scored.filter((s) => !s.needsWords || mentionsChickens(animal.text));
  const hits = open.filter((s) => s.hit);
  if (hits.length === 1) return { petId: hits[0].pet.id, score: 0 };
  const flocks = open.filter((s) => s.pet.isFlock);
  return flocks.length === 1 ? { petId: flocks[0].pet.id, score: 0 } : null;
}

/** Mean of unit vectors, renormalised. */
export function centroidOf(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
  const norm = Math.sqrt(sum.reduce((a, x) => a + x * x, 0));
  return norm ? sum.map((x) => x / norm) : null;
}
