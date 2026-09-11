/**
 * Pure matching for animal detections: which pet, if any, is this crop probably? Species must agree, the pet must
 * have been with the family when the photo was taken, a pet the member already said "no" to on this photo is never
 * proposed again, and a flock record ("the chickens") is proposed whenever its species is seen at all. Otherwise the
 * best cosine similarity to a pet's confirmed crops must clear the threshold.
 */
export const ANIMAL_MATCH_THRESHOLD = 0.82;

export type PetCandidate = { id: string; species: string | null; isFlock: boolean; livedFrom: Date | null; livedTo: Date | null; centroid: number[] | null };
export type AnimalToMatch = { species: string; embedding: number[] | null; takenAt: Date | null; rejectedPetIds: string[] };

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

export function matchAnimal(animal: AnimalToMatch, pets: PetCandidate[], threshold = ANIMAL_MATCH_THRESHOLD): { petId: string; score: number } | null {
  const eligible = pets.filter((p) => p.species === animal.species && !animal.rejectedPetIds.includes(p.id) && aliveAt(p, animal.takenAt));
  let best: { petId: string; score: number } | null = null;
  if (animal.embedding) {
    for (const p of eligible) {
      if (!p.centroid) continue;
      const score = cosine(animal.embedding, p.centroid);
      if (score >= threshold && (!best || score > best.score)) best = { petId: p.id, score };
    }
  }
  if (best) return best;
  // With no look-alike, a flock of that species is the answer when there is exactly one such flock.
  const flocks = eligible.filter((p) => p.isFlock);
  return flocks.length === 1 ? { petId: flocks[0].id, score: 0 } : null;
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
