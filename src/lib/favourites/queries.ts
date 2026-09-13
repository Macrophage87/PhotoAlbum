import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/viewer";

/**
 * Favourites, and the order they put things in.
 *
 * The rule is the same everywhere: what this member marked comes first, then what the family marked most, then
 * whatever order the list had anyway. It is kept per person rather than as a counter on the row, so one person's
 * choice never overwrites another's, and "how many of us like this" is a count rather than a guess.
 */

export type FavouriteKind = "photo" | "trip" | "collection";

/** What a card needs to draw the heart: whether it is mine, and how many of us have marked it. */
export type FavouriteState = { mine: boolean; count: number };
export type FavouriteMap = Map<string, FavouriteState>;

const TABLE = { photo: "PhotoFavorite", trip: "TripFavorite", collection: "CollectionFavorite" } as const;
const COLUMN = { photo: "photoId", trip: "tripId", collection: "collectionId" } as const;

/** Mine and the totals for a page of things, in two small queries rather than one per card. */
export async function favouritesFor(kind: FavouriteKind, ids: string[], viewer: Viewer): Promise<FavouriteMap> {
  const out: FavouriteMap = new Map();
  if (!ids.length) return out;
  const table = Prisma.raw(`"${TABLE[kind]}"`);
  const column = Prisma.raw(`"${COLUMN[kind]}"`);
  const counts = await db.$queryRaw<{ id: string; n: bigint }[]>`
    SELECT ${column} AS id, count(*) AS n FROM ${table} WHERE ${column} IN (${Prisma.join(ids)}) GROUP BY ${column}`;
  for (const c of counts) out.set(c.id, { mine: false, count: Number(c.n) });
  if (viewer.kind === "user") {
    const mine = await db.$queryRaw<{ id: string }[]>`
      SELECT ${column} AS id FROM ${table} WHERE "userId" = ${viewer.user.id} AND ${column} IN (${Prisma.join(ids)})`;
    for (const m of mine) out.set(m.id, { mine: true, count: out.get(m.id)?.count ?? 0 });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { mine: false, count: 0 });
  return out;
}

/** Mark or unmark one thing. Returns what the heart should show afterwards. */
export async function setFavourite(kind: FavouriteKind, id: string, userId: string, on: boolean): Promise<FavouriteState> {
  const table = Prisma.raw(`"${TABLE[kind]}"`);
  const column = Prisma.raw(`"${COLUMN[kind]}"`);
  if (on) {
    // Marking something twice is the same as marking it once, and two tabs racing must not fail.
    await db.$executeRaw`INSERT INTO ${table} ("userId", ${column}, "createdAt") VALUES (${userId}, ${id}, now()) ON CONFLICT DO NOTHING`;
  } else {
    await db.$executeRaw`DELETE FROM ${table} WHERE "userId" = ${userId} AND ${column} = ${id}`;
  }
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ${table} WHERE ${column} = ${id}`;
  return { mine: on, count: Number(n) };
}

/**
 * The ordering every favourite-aware list shares: mine first, then the ones most of the family marked, then the
 * list's own order as a tie-break so it stays steady rather than shuffling between loads.
 */
export function favouriteOrderSql(kind: FavouriteKind, alias: string, viewerId: string | null, tail: Prisma.Sql): Prisma.Sql {
  const table = Prisma.raw(`"${TABLE[kind]}"`);
  const column = Prisma.raw(`"${COLUMN[kind]}"`);
  const row = Prisma.raw(`${alias}.id`);
  const mine = viewerId
    ? Prisma.sql`(EXISTS (SELECT 1 FROM ${table} f WHERE f.${column} = ${row} AND f."userId" = ${viewerId})) DESC,`
    : Prisma.empty;
  return Prisma.sql`ORDER BY ${mine} (SELECT count(*) FROM ${table} f2 WHERE f2.${column} = ${row}) DESC, ${tail}`;
}

/** Favourite state for a page of photo cards, ready to hand to `toGridPhoto`. */
export async function photoFavourites(ids: string[], viewer: Viewer): Promise<FavouriteMap> {
  return viewer.kind === "user" ? favouritesFor("photo", ids, viewer) : new Map();
}
