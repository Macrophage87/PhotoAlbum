import { db } from "@/lib/db";

/** Neighbours kept per item, and the cosine similarity below which a pair is not worth an edge. */
export const NEIGHBOURS = 8;
export const MIN_SCORE = 0.75;

/** Store one row per unordered pair, smaller id first. Pure. */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** After an image embedding lands: upsert this item's nearest neighbours above the floor into MediaSimilarity. */
export async function upsertNeighbours(photoId: string): Promise<number> {
  const rows = await db.$queryRaw<{ id: string; score: number }[]>`
    SELECT o.id, 1 - (o.embedding <=> p.embedding) AS score
    FROM "Photo" p JOIN "Photo" o ON o.id <> p.id AND o.embedding IS NOT NULL
    WHERE p.id = ${photoId} AND p.embedding IS NOT NULL
    ORDER BY o.embedding <=> p.embedding
    LIMIT ${NEIGHBOURS}`;
  let n = 0;
  for (const r of rows) {
    const score = Number(r.score);
    if (score < MIN_SCORE) continue;
    const [a, b] = orderPair(photoId, r.id);
    await db.$executeRaw`INSERT INTO "MediaSimilarity" ("photoAId", "photoBId", score) VALUES (${a}, ${b}, ${score}) ON CONFLICT ("photoAId", "photoBId") DO UPDATE SET score = EXCLUDED.score`;
    n += 1;
  }
  return n;
}
