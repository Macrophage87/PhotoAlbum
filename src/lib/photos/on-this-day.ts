import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";
import { localTakenAtSql, tripZoneFixes } from "@/lib/time/local-day-sql";
import { readableTitle } from "./readable-text";

/** How many photographs one earlier year shows, and how many the whole row shows. Enough to remember, few enough to load. */
export const ON_THIS_DAY_PER_YEAR = 4;
export const ON_THIS_DAY_LIMIT = 16;

export type OnThisDayPhoto = {
  id: string;
  imageVersion: number;
  width: number | null;
  height: number | null;
  year: number;
  title: string | null;
  caption: string | null;
  tripTitle: string | null;
  tripSlug: string | null;
};

/**
 * The day the viewer is on, as their own calendar has it ("2026-11-23"), and nothing else. The server does not know
 * which day it is where the family member is sitting, so the page asks with the date the browser reads off its own
 * clock. Anything that is not a real calendar day is refused.
 */
export function parseCalendarDay(raw: string | null | undefined): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  if (year < 1900 || year > 9998) return null;
  return { year, month, day };
}

/**
 * Photographs taken on this day of the year in earlier years, read on the clock where each was taken (so a photo
 * from an evening in Hawaii counts for that evening, not for the next morning in UTC). Newest year first, a few from
 * each year, the family's favourites leading. A visitor sees only what is public, as on every other album-wide page.
 * Only finished photographs: a clip or a scan in a row of pictures is a tile that does nothing.
 */
export async function onThisDay(viewer: Viewer, today: { year: number; month: number; day: number }, opts: { perYear?: number; limit?: number } = {}): Promise<OnThisDayPhoto[]> {
  const perYear = opts.perYear ?? ON_THIS_DAY_PER_YEAR;
  const limit = opts.limit ?? ON_THIS_DAY_LIMIT;
  const fixes = await tripZoneFixes();
  const local = localTakenAtSql(fixes);
  const visible = viewer.kind === "user"
    ? Prisma.sql`TRUE`
    : Prisma.sql`((t.visibility = 'PUBLIC' AND t."deletingAt" IS NULL) OR EXISTS (
        SELECT 1 FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId"
        WHERE ci."photoId" = p.id AND c.visibility = 'PUBLIC'))`;
  const tripNamed = viewer.kind === "user" ? Prisma.sql`TRUE` : Prisma.sql`(t.visibility = 'PUBLIC' AND t."deletingAt" IS NULL)`;
  // The same pick all day, a different one tomorrow: shuffled by the day, so a visit after lunch shows what the
  // morning did, and favourites still come first.
  const seed = `${today.month}-${today.day}`;
  const rows = await db.$queryRaw<(OnThisDayPhoto & { membersTitle: string | null })[]>`
    SELECT id, "imageVersion", width, height, year, title, "membersTitle", caption, "tripTitle", "tripSlug" FROM (
      SELECT p.id, p."imageVersion", p.width, p.height, p.title, p."membersTitle", p.caption,
             -- A photo a visitor reaches through a public collection may sit on a private trip, whose name is not theirs to read.
             CASE WHEN ${tripNamed} THEN t.title END AS "tripTitle", CASE WHEN ${tripNamed} THEN t.slug END AS "tripSlug",
             EXTRACT(YEAR FROM ${local})::int AS year,
             ROW_NUMBER() OVER (
               PARTITION BY EXTRACT(YEAR FROM ${local})
               ORDER BY (SELECT count(*) FROM "PhotoFavorite" f WHERE f."photoId" = p.id) DESC, md5(p.id || ${seed})
             ) AS n
      FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId"
      WHERE p."trashedAt" IS NULL AND p.status = 'READY' AND p.kind = 'PHOTO' AND p.width IS NOT NULL
        AND p."takenAt" IS NOT NULL
        AND EXTRACT(MONTH FROM ${local}) = ${today.month}::int
        AND EXTRACT(DAY FROM ${local}) = ${today.day}::int
        AND EXTRACT(YEAR FROM ${local}) < ${today.year}::int
        AND ${visible}
    ) picked
    WHERE n <= ${perYear}
    ORDER BY year DESC, n ASC
    LIMIT ${limit}`;
  return rows.map(({ membersTitle, ...r }) => ({ ...r, title: readableTitle({ title: r.title, membersTitle }, viewer.kind === "user"), year: Number(r.year) }));
}
