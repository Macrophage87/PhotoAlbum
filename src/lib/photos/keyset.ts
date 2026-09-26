import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/** One column of a gallery's order, the way Prisma is told it. `nullsLast` for a column that can be empty. */
export type KeyColumn = { field: "takenAt" | "createdAt"; dir: "asc" | "desc"; nullsLast?: boolean };
type Keyed = { id: string; takenAt?: Date | null; createdAt?: Date };

/**
 * Where the next page starts, carried as the last item's own sort values and id rather than as its id alone.
 *
 * The cursor used to be only the id, looked up again to find the place. If that photograph had been filed on a trip,
 * put in the bin or deleted since the page was shown, the place was gone: Prisma then started one row after wherever
 * the row now sat in the list (skipping a photograph), or found nothing and ended the gallery early. A position
 * written out in full is still a position when the row it came from has left.
 */
export function encodeCursor(row: Keyed, columns: KeyColumn[]): string {
  return [...columns.map((c) => (row[c.field] ? row[c.field]!.getTime().toString() : "")), row.id].join(".");
}

/** The cursor read back, or null if it is not one of ours — an old id-only cursor from a page opened before. */
export function decodeCursor(cursor: string, columns: KeyColumn[]): { values: (Date | null)[]; id: string } | null {
  const parts = cursor.split(".");
  if (parts.length !== columns.length + 1 || !parts[columns.length]) return null;
  const values: (Date | null)[] = [];
  for (const [i, c] of columns.entries()) {
    if (parts[i] === "" && c.nullsLast) values.push(null);
    else if (/^-?\d+$/.test(parts[i]) && Number.isFinite(new Date(Number(parts[i])).getTime())) values.push(new Date(Number(parts[i])));
    // Anything else, a date too far off to be one included, is not a cursor we wrote.
    else return null;
  }
  return { values, id: parts[columns.length] };
}

/**
 * Everything after a position in the order `columns` then id (in the last column's direction), as a where clause:
 * later on the first column, or level with it and later on the next, and so on down to the id. An empty column that
 * sorts last comes after every value in it, and nothing comes after it but its own ties.
 */
export function afterCursor(pos: { values: (Date | null)[]; id: string }, columns: KeyColumn[]): Prisma.PhotoWhereInput {
  const or: Prisma.PhotoWhereInput[] = [];
  const level: Prisma.PhotoWhereInput[] = [];
  columns.forEach((c, i) => {
    const v = pos.values[i];
    if (v !== null) {
      or.push({ AND: [...level, { [c.field]: c.dir === "asc" ? { gt: v } : { lt: v } }] });
      if (c.nullsLast) or.push({ AND: [...level, { [c.field]: null }] });
    }
    level.push({ [c.field]: v });
  });
  const dir = columns[columns.length - 1]?.dir ?? "asc";
  or.push({ AND: [...level, { id: dir === "asc" ? { gt: pos.id } : { lt: pos.id } }] });
  return { OR: or };
}

/**
 * The where clause for "after this cursor". A cursor from before positions were written out is only an id: that
 * row is looked up once for its place, as it always was, and if it has gone there is nowhere to continue from.
 */
export async function cursorWhere(cursor: string | null | undefined, columns: KeyColumn[]): Promise<Prisma.PhotoWhereInput> {
  if (!cursor) return {};
  const pos = decodeCursor(cursor, columns);
  if (pos) return afterCursor(pos, columns);
  const row = await db.photo.findUnique({ where: { id: cursor }, select: { id: true, takenAt: true, createdAt: true } });
  return row ? afterCursor({ values: columns.map((c) => row[c.field] ?? null), id: row.id }, columns) : { id: { in: [] } };
}
