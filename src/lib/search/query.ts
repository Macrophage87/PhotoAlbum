import { Prisma } from "@/generated/prisma/client";
import type { MediaKind } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleContainersWhere } from "@/lib/auth/access";
import { embedText, mlConfigured, vectorLiteral } from "@/lib/ml/client";

export type SearchParams = { q: string; tripId?: string; collectionId?: string; uploaderId?: string; personId?: string; year?: number; kind?: MediaKind };

export type SearchHit = {
  id: string;
  kind: MediaKind;
  status: "READY";
  caption: string | null;
  title: string | null;
  originalName: string;
  externalId: string | null;
  externalStatus: string | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  takenAt: Date | null;
  tzOffsetMin: number | null;
  updatedAt: Date;
  gpsSource: string | null;
  tripSlug: string | null;
  tripTitle: string | null;
  /** Members only; null for anonymous viewers. */
  uploaderName: string | null;
  rank: number;
  /** Plain text with [[ ]] around matches; never HTML from the database. */
  snippet: string;
};

export const MAX_QUERY_LENGTH = 200;

/** Weight of the keyword score against the semantic score. One constant; change it only when the query test set motivates it. */
export const KEYWORD_WEIGHT = 0.7;
/** Below this cosine similarity a semantic-only neighbour is not worth showing. */
export const SEMANTIC_FLOOR = 0.3;

/** Blend a keyword rank (any scale, normalised by the best hit) with a cosine similarity in [0, 1]. Pure, for the tests. */
export function blendScore(keywordRank: number, bestKeywordRank: number, similarity: number | null): number {
  const kw = bestKeywordRank > 0 ? keywordRank / bestKeywordRank : 0;
  const sem = similarity === null ? 0 : Math.max(0, similarity);
  return KEYWORD_WEIGHT * kw + (1 - KEYWORD_WEIGHT) * sem;
}

/** Trim and cap the raw query; Postgres' websearch parser copes with quotes, minus and OR on its own. */
export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** SQL restricting media to what the viewer may see on a global surface; share cookies never widen it. */
export function visibilitySql(viewer: Viewer): Prisma.Sql {
  if (viewer.kind === "user") return Prisma.sql`TRUE`;
  return Prisma.sql`(t.visibility = 'PUBLIC' OR EXISTS (SELECT 1 FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id AND c.visibility = 'PUBLIC'))`;
}

/**
 * Keyword search. Members query the column that also carries names; anonymous visitors query the base column, so a
 * name never enters their ranking. The uploader filter is a members-only control and is ignored otherwise.
 */
export async function searchMedia(viewer: Viewer, params: SearchParams, limit = 120, embed: ((q: string) => Promise<number[] | null>) | null = defaultEmbed): Promise<SearchHit[]> {
  const q = normalizeQuery(params.q);
  if (!q) return [];
  const queryVec = embed ? await embed(q) : null;
  const member = viewer.kind === "user";
  const column = member ? Prisma.sql`p."searchVectorMembers"` : Prisma.sql`p."searchVector"`;
  const filters: Prisma.Sql[] = [];
  if (params.tripId) filters.push(Prisma.sql`p."tripId" = ${params.tripId}`);
  if (params.collectionId) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "CollectionItem" ci2 WHERE ci2."photoId" = p.id AND ci2."collectionId" = ${params.collectionId})`);
  if (member && params.uploaderId) filters.push(Prisma.sql`p."uploaderId" = ${params.uploaderId}`);
  if (member && params.personId) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "Face" f2 WHERE f2."photoId" = p.id AND f2."personId" = ${params.personId} AND f2.status = 'CONFIRMED')`);
  if (params.year) filters.push(Prisma.sql`EXTRACT(YEAR FROM (p."takenAt" + make_interval(mins => COALESCE(p."tzOffsetMin", 0)))) = ${params.year}`);
  if (params.kind) filters.push(Prisma.sql`p.kind = ${params.kind}::"MediaKind"`);
  const where = filters.length ? Prisma.join(filters, " AND ") : Prisma.sql`TRUE`;
  const uploader = member ? Prisma.sql`u.name` : Prisma.sql`NULL`;
  // A private trip's title is members-only metadata: anonymous visitors see the trip of a hit only when they may open that trip.
  // Same rule as canViewTrip: a held share cookie counts only while the trip is LINK and the token still matches.
  const shareTokens = [...viewer.shareTokens.entries()].filter(([k]) => k.startsWith("trip_")).map(([, v]) => v);
  const tripVisible = member ? Prisma.sql`TRUE` : shareTokens.length ? Prisma.sql`(t.visibility = 'PUBLIC' OR (t.visibility = 'LINK' AND t."shareToken" IN (${Prisma.join(shareTokens)})))` : Prisma.sql`t.visibility = 'PUBLIC'`;
  // Semantic half: cosine similarity of the query embedding to the item's description embedding, when both exist.
  const similarity = queryVec ? Prisma.sql`CASE WHEN p."textEmbedding" IS NULL THEN NULL ELSE 1 - (p."textEmbedding" <=> ${vectorLiteral(queryVec)}::vector) END` : Prisma.sql`NULL::float`;
  const match = queryVec ? Prisma.sql`(${column} @@ query OR (p."textEmbedding" IS NOT NULL AND 1 - (p."textEmbedding" <=> ${vectorLiteral(queryVec)}::vector) >= ${SEMANTIC_FLOOR}))` : Prisma.sql`${column} @@ query`;
  const rows = await db.$queryRaw<(SearchHit & { similarity: number | null })[]>`
    SELECT p.id, p.kind, p.status, p.caption, p.title, p."originalName", p."externalId", p."externalStatus", p."durationS", p.width, p.height,
           p."takenAt", p."tzOffsetMin", p."updatedAt", p."gpsSource",
           CASE WHEN ${tripVisible} THEN t.slug END AS "tripSlug", CASE WHEN ${tripVisible} THEN t.title END AS "tripTitle", ${uploader} AS "uploaderName",
           ts_rank_cd(${column}, query) AS rank,
           ${similarity} AS similarity,
           ts_headline('english', concat_ws(' · ', p.caption, p.title, p.context, p.annotation->>'caption'), query, 'MaxWords=18, MinWords=6, StartSel=[[, StopSel=]], MaxFragments=1') AS snippet
    FROM "Photo" p
    LEFT JOIN "Trip" t ON t.id = p."tripId"
    LEFT JOIN "User" u ON u.id = p."uploaderId",
    LATERAL (SELECT websearch_to_tsquery('english', ${q}) || websearch_to_tsquery('simple', ${q}) AS query) qq
    WHERE p.status = 'READY' AND ${match} AND ${visibilitySql(viewer)} AND ${where}
    ORDER BY rank DESC, p."takenAt" DESC NULLS LAST
    LIMIT ${limit * 2}
  `;
  const best = rows.reduce((m, r) => Math.max(m, Number(r.rank)), 0);
  return rows
    .map((r) => ({ ...r, rank: blendScore(Number(r.rank), best, r.similarity === null ? null : Number(r.similarity)) }))
    .sort((a, b) => b.rank - a.rank || (b.takenAt?.getTime() ?? 0) - (a.takenAt?.getTime() ?? 0))
    .slice(0, limit);
}

/** The query embedding from the sidecar, or null when it is not configured or not answering (keyword-only then). */
async function defaultEmbed(q: string): Promise<number[] | null> {
  if (!mlConfigured()) return null;
  try {
    return (await embedText([q]))[0] ?? null;
  } catch {
    return null;
  }
}

export type SearchFacets = {
  trips: { id: string; title: string }[];
  collections: { id: string; title: string }[];
  /** Empty for anonymous viewers: the member list is never served to them. */
  uploaders: { id: string; name: string | null }[];
  /** Members only: every confirmed person and pet who has not opted out. */
  people: { id: string; name: string }[];
  years: number[];
};

/** Filter options built from the viewer's visible set only. */
export async function searchFacets(viewer: Viewer): Promise<SearchFacets> {
  const member = viewer.kind === "user";
  const [trips, collections, uploaders, people, years] = await Promise.all([
    db.trip.findMany({ where: visibleContainersWhere(viewer), orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    db.collection.findMany({ where: visibleContainersWhere(viewer), orderBy: { title: "asc" }, select: { id: true, title: true } }),
    member ? db.user.findMany({ where: { photos: { some: {} } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    member ? db.person.findMany({ where: { optedOutAt: null, faces: { some: { status: "CONFIRMED" } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    db.$queryRaw<{ year: number }[]>`
      SELECT DISTINCT EXTRACT(YEAR FROM (p."takenAt" + make_interval(mins => COALESCE(p."tzOffsetMin", 0))))::int AS year
      FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId"
      WHERE p."takenAt" IS NOT NULL AND p.status = 'READY' AND ${visibilitySql(viewer)}
      ORDER BY year DESC`,
  ]);
  return { trips, collections, uploaders, people, years: years.map((y) => y.year) };
}
