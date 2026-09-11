/**
 * Matching a new face against consented people, as pure functions so the age-band selection, thresholds and
 * negatives are unit-tested. Every match is a proposal: nothing is named without a member confirming.
 */
import { cosine } from "./cluster";

/** Adults match at the ordinary threshold; childhood faces (siblings look alike) need a stricter one. */
export const ADULT_THRESHOLD = 0.6;
export const CHILD_THRESHOLD = 0.72;
export const CHILDHOOD_MAX_AGE = 13;
/** Rejected faces this close to a new face veto the person they were rejected for. */
export const NEGATIVE_THRESHOLD = 0.5;
/** Age band tolerance around a cluster's band: tight with a known date, wider with an estimated one. */
export const BAND_PAD_KNOWN = 4;
export const BAND_PAD_ESTIMATED = 8;

export type AgeAtCapture = { years: number; basis: "known" | "estimated" | "model" } | null;

/** Age at capture from the person's birthday and the photo's real date, else its estimated date, else the model's guess. */
export function ageAtCapture(birthday: Date | null, takenAt: Date | null, estimatedDate: Date | null, modelAge: number | null): AgeAtCapture {
  if (birthday && takenAt) return { years: yearsBetween(birthday, takenAt), basis: "known" };
  if (birthday && estimatedDate) return { years: yearsBetween(birthday, estimatedDate), basis: "estimated" };
  if (modelAge !== null && Number.isFinite(modelAge)) return { years: modelAge, basis: "model" };
  return null;
}

export function yearsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365.25 * 86_400_000);
}

export type CandidateCluster = { id: string; personId: string; ageBandMin: number | null; ageBandMax: number | null; similarity: number };

/** A cluster is a candidate when its age band, padded, covers the face's age; bandless clusters and ageless faces always are. */
export function bandAllows(cluster: Pick<CandidateCluster, "ageBandMin" | "ageBandMax">, age: AgeAtCapture): boolean {
  if (!age || cluster.ageBandMin === null || cluster.ageBandMax === null) return true;
  const pad = age.basis === "known" ? BAND_PAD_KNOWN : BAND_PAD_ESTIMATED;
  return age.years >= cluster.ageBandMin - pad && age.years <= cluster.ageBandMax + pad;
}

export function thresholdFor(age: AgeAtCapture): number {
  if (age && age.years < CHILDHOOD_MAX_AGE) return CHILD_THRESHOLD;
  // Unknown age: a little stricter than an adult match, since it may well be a childhood photo.
  return age ? ADULT_THRESHOLD : ADULT_THRESHOLD + 0.05;
}

export type Match = { personId: string; clusterId: string; similarity: number; childhood: boolean };

/**
 * Pick the best proposal: the most similar candidate cluster whose band allows this age, above the threshold for the
 * age, whose person is not vetoed by a rejected face close to this one.
 */
export function pickMatch(candidates: CandidateCluster[], age: AgeAtCapture, vetoedPersonIds: Iterable<string>): Match | null {
  const vetoed = new Set(vetoedPersonIds);
  const threshold = thresholdFor(age);
  let best: CandidateCluster | null = null;
  for (const c of candidates) {
    if (vetoed.has(c.personId) || !bandAllows(c, age) || c.similarity < threshold) continue;
    if (!best || c.similarity > best.similarity) best = c;
  }
  return best ? { personId: best.personId, clusterId: best.id, similarity: best.similarity, childhood: Boolean(age && age.years < CHILDHOOD_MAX_AGE) } : null;
}

/** People vetoed by rejected faces that look like this one. */
export function vetoes(embedding: number[], rejected: { proposedPersonId: string; embedding: number[] }[]): string[] {
  return [...new Set(rejected.filter((r) => cosine(embedding, r.embedding) >= NEGATIVE_THRESHOLD).map((r) => r.proposedPersonId))];
}

/** Which of a person's era clusters a confirmed face joins: the one whose band covers the age, else the nearest band, else none (create one). */
export function chooseEraCluster<C extends { id: string; ageBandMin: number | null; ageBandMax: number | null }>(clusters: C[], age: AgeAtCapture): C | null {
  if (!clusters.length) return null;
  if (!age) return clusters.find((c) => c.ageBandMin === null) ?? clusters[0];
  const covering = clusters.find((c) => c.ageBandMin !== null && c.ageBandMax !== null && age.years >= c.ageBandMin && age.years <= c.ageBandMax);
  if (covering) return covering;
  let best: C | null = null, bestGap = Infinity;
  for (const c of clusters) {
    if (c.ageBandMin === null || c.ageBandMax === null) continue;
    const gap = age.years < c.ageBandMin ? c.ageBandMin - age.years : age.years - c.ageBandMax;
    if (gap < bestGap) { best = c; bestGap = gap; }
  }
  if (best && bestGap <= BAND_PAD_KNOWN) return best;
  // A face more than a band's width away from every era starts a new era cluster, unless a bandless cluster (named before any age was known) can take it.
  return clusters.find((c) => c.ageBandMin === null) ?? null;
}

/** A cluster's band grows to include the ages of the faces in it. */
export function widenedBand(cluster: { ageBandMin: number | null; ageBandMax: number | null }, age: AgeAtCapture): { ageBandMin: number | null; ageBandMax: number | null } {
  if (!age) return { ageBandMin: cluster.ageBandMin, ageBandMax: cluster.ageBandMax };
  const y = Math.round(age.years);
  return { ageBandMin: cluster.ageBandMin === null ? y : Math.min(cluster.ageBandMin, y), ageBandMax: cluster.ageBandMax === null ? y : Math.max(cluster.ageBandMax, y) };
}

/** Intersection over union of two fractional boxes, to recognise a face found again on a re-scan. */
export function boxIou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
