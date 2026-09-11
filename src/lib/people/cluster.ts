/** Online clustering of face templates: join the nearest cluster above a similarity threshold, else start one. Pure. */
export const JOIN_THRESHOLD = 0.6;

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

/** The nearest cluster and its similarity, or null when none is close enough. */
export function nearestCluster<C extends { id: string; centroid: number[] }>(embedding: number[], clusters: C[], threshold = JOIN_THRESHOLD): { cluster: C; similarity: number } | null {
  let best: { cluster: C; similarity: number } | null = null;
  for (const c of clusters) {
    const s = cosine(embedding, c.centroid);
    if (s >= threshold && (!best || s > best.similarity)) best = { cluster: c, similarity: s };
  }
  return best;
}

/** Running mean of unit vectors, renormalised. */
export function updatedCentroid(centroid: number[], count: number, embedding: number[]): number[] {
  return normalise(centroid.map((c, i) => (c * count + embedding[i]) / (count + 1)));
}
