import { Prisma } from "@/generated/prisma/client";
import type { MediaKind } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleContainersWhere } from "@/lib/auth/access";

export type SearchParams = { q: string; tripId?: string; collectionId?: string; uploaderId?: string; year?: number; kind?: MediaKind };

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
export async function searchMedia(viewer: Viewer, params: SearchParams, limit = 120): Promise<SearchHit[]> {
  const q = normalizeQuery(params.q);
  if (!q) return [];
  const member = viewer.kind === "user";
  const column = member ? Prisma.sql`p."searchVectorMembers"` : Prisma.sql`p."searchVector"`;
  const filters: Prisma.Sql[] = [];
  if (params.tripId) filters.push(Prisma.sql`p."tripId" = ${params.tripId}`);
  if (params.collectionId) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "CollectionItem" ci2 WHERE ci2."photoId" = p.id AND ci2."collectionId" = ${params.collectionId})`);
  if (member && params.uploaderId) filters.push(Prisma.sql`p."uploaderId" = ${params.uploaderId}`);
  if (params.year) filters.push(Prisma.sql`EXTRACT(YEAR FROM (p."takenAt" + make_interval(mins => COALESCE(p."tzOffsetMin", 0)))) = ${params.year}`);
  if (params.kind) filters.push(Prisma.sql`p.kind = ${params.kind}::"MediaKind"`);
  const where = filters.length ? Prisma.join(filters, " AND ") : Prisma.sql`TRUE`;
  const uploader = member ? Prisma.sql`u.name` : Prisma.sql`NULL`;
  return db.$queryRaw<SearchHit[]>`
    SELECT p.id, p.kind, p.status, p.caption, p.title, p."originalName", p."externalId", p."externalStatus", p."durationS", p.width, p.height,
           p."takenAt", p."tzOffsetMin", p."updatedAt", p."gpsSource",
           t.slug AS "tripSlug", t.title AS "tripTitle", ${uploader} AS "uploaderName",
           ts_rank_cd(${column}, query) AS rank,
           ts_headline('english', concat_ws(' · ', p.caption, p.title, p.context), query, 'MaxWords=18, MinWords=6, StartSel=[[, StopSel=]], MaxFragments=1') AS snippet
    FROM "Photo" p
    LEFT JOIN "Trip" t ON t.id = p."tripId"
    LEFT JOIN "User" u ON u.id = p."uploaderId",
    websearch_to_tsquery('english', ${q}) query
    WHERE p.status = 'READY' AND ${column} @@ query AND ${visibilitySql(viewer)} AND ${where}
    ORDER BY rank DESC, p."takenAt" DESC NULLS LAST
    LIMIT ${limit}
  `;
}

export type SearchFacets = {
  trips: { id: string; title: string }[];
  collections: { id: string; title: string }[];
  /** Empty for anonymous viewers: the member list is never served to them. */
  uploaders: { id: string; name: string | null }[];
  years: number[];
};

/** Filter options built from the viewer's visible set only. */
export async function searchFacets(viewer: Viewer): Promise<SearchFacets> {
  const member = viewer.kind === "user";
  const [trips, collections, uploaders, years] = await Promise.all([
    db.trip.findMany({ where: visibleContainersWhere(viewer), orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    db.collection.findMany({ where: visibleContainersWhere(viewer), orderBy: { title: "asc" }, select: { id: true, title: true } }),
    member ? db.user.findMany({ where: { photos: { some: {} } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    db.$queryRaw<{ year: number }[]>`
      SELECT DISTINCT EXTRACT(YEAR FROM (p."takenAt" + make_interval(mins => COALESCE(p."tzOffsetMin", 0))))::int AS year
      FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId"
      WHERE p."takenAt" IS NOT NULL AND p.status = 'READY' AND ${visibilitySql(viewer)}
      ORDER BY year DESC`,
  ]);
  return { trips, collections, uploaders, years: years.map((y) => y.year) };
}
