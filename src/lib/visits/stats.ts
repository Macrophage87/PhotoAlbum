import { db } from "@/lib/db";
import { photoUrl } from "@/lib/photos/urls";
import { dayKey, serverTimeZone } from "./record";

export type KindCount = { kind: "MEMBER" | "SHARE" | "PUBLIC"; visits: number; visitors: number };
export type DayCount = { day: string; visits: number; visitors: number };
export type ThingCount = { id: string; title: string; href: string; visibility?: string; visits: number; visitors: number; shareVisits: number; last: Date; thumbUrl?: string | null };
export type MemberCount = { id: string; name: string | null; email: string; visits: number; last: Date | null };

export type VisitorStats = {
  days: number;
  since: Date;
  /** The oldest visit still kept, so the panel can say plainly that counting began when it began. */
  earliest: Date | null;
  totals: { visits: number; visitors: number };
  byKind: KindCount[];
  daily: DayCount[];
  trips: ThingCount[];
  collections: ThingCount[];
  items: ThingCount[];
  referrers: { host: string; visits: number }[];
  members: MemberCount[];
};

/**
 * Everything the Admin page says about who has been looking, over the last `days` days.
 *
 * Visits are counted per page opened; visitors are distinct browsers for the window, which is a floor rather than a
 * headcount — a relative on a phone and then a laptop is two, and a household behind one address on one browser is
 * one. The panel says so rather than pretending otherwise.
 */
export async function visitorStats(days = 30): Promise<VisitorStats> {
  const tz = serverTimeZone();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totals, byKind, daily, trips, collections, items, referrers, members, earliest] = await Promise.all([
    db.$queryRaw<{ visits: number; visitors: number }[]>`
      SELECT count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors FROM "Visit" v WHERE v."at" >= ${since}`,
    db.$queryRaw<KindCount[]>`
      SELECT v.kind::text AS kind, count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors
      FROM "Visit" v WHERE v."at" >= ${since} GROUP BY 1`,
    // Postgres holds the moment in UTC; every "day" the album talks about is a day in the server's own zone.
    db.$queryRaw<DayCount[]>`
      SELECT to_char((v."at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text, 'YYYY-MM-DD') AS day,
             count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors
      FROM "Visit" v WHERE v."at" >= ${since} GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<ThingCount[]>`
      SELECT t.id, t.title, '/trips/' || t.slug AS href, t.visibility::text AS visibility,
             count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors,
             count(*) FILTER (WHERE v.kind = 'SHARE')::int AS "shareVisits", max(v."at") AS last
      FROM "Visit" v JOIN "Trip" t ON t.id = v."tripId"
      WHERE v."at" >= ${since} GROUP BY t.id ORDER BY visitors DESC, visits DESC LIMIT 8`,
    db.$queryRaw<ThingCount[]>`
      SELECT c.id, c.title, '/collections/' || c.slug AS href, c.visibility::text AS visibility,
             count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors,
             count(*) FILTER (WHERE v.kind = 'SHARE')::int AS "shareVisits", max(v."at") AS last
      FROM "Visit" v JOIN "Collection" c ON c.id = v."collectionId"
      WHERE v."at" >= ${since} GROUP BY c.id ORDER BY visitors DESC, visits DESC LIMIT 8`,
    db.$queryRaw<(ThingCount & { updatedAt: Date; renditions: unknown })[]>`
      SELECT p.id, coalesce(nullif(p.title, ''), nullif(p.caption, ''), p."originalName") AS title,
             '/photos/' || p.id AS href, p."updatedAt", p.renditions,
             count(*)::int AS visits, count(DISTINCT v."visitorHash")::int AS visitors,
             count(*) FILTER (WHERE v.kind = 'SHARE')::int AS "shareVisits", max(v."at") AS last
      FROM "Visit" v JOIN "Photo" p ON p.id = v."photoId"
      WHERE v."at" >= ${since} GROUP BY p.id ORDER BY visitors DESC, visits DESC LIMIT 6`,
    db.$queryRaw<{ host: string; visits: number }[]>`
      SELECT v."refHost" AS host, count(*)::int AS visits FROM "Visit" v
      WHERE v."at" >= ${since} AND v."refHost" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    db.$queryRaw<MemberCount[]>`
      SELECT u.id, u.name, u.email,
             count(v.id) FILTER (WHERE v."at" >= ${since})::int AS visits,
             max(v."at") AS last
      FROM "User" u LEFT JOIN "Visit" v ON v."userId" = u.id
      GROUP BY u.id ORDER BY max(v."at") DESC NULLS LAST, u.email`,
    db.visit.findFirst({ orderBy: { at: "asc" }, select: { at: true } }),
  ]);

  return {
    days,
    since,
    earliest: earliest?.at ?? null,
    totals: totals[0] ?? { visits: 0, visitors: 0 },
    byKind,
    daily: fillGaps(daily, days, tz),
    trips,
    collections,
    items: items.map((i) => ({ ...i, thumbUrl: i.renditions ? photoUrl(i, "thumb") : null })),
    referrers,
    members,
  };
}

/** A day nobody looked is a gap in the grouped rows and a zero on the chart; the chart wants every day in order. */
export function fillGaps(rows: DayCount[], days: number, tz = "UTC", now = new Date()): DayCount[] {
  const found = new Map(rows.map((r) => [r.day, r]));
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000), tz);
    out.push(found.get(day) ?? { day, visits: 0, visitors: 0 });
  }
  return out;
}
