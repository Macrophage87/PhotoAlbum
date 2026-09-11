/** The both-endpoints rule as a pure function: an edge is returned only when the viewer may see both items. Nothing is redacted or counted. */
export type Edge = { a: string; b: string; score: number };

export function edgesWithin(edges: Edge[], visible: Set<string>, minScore = 0): Edge[] {
  return edges.filter((e) => e.score >= minScore && visible.has(e.a) && visible.has(e.b));
}
