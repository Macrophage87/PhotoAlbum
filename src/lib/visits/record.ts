import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { shareKey } from "@/lib/auth/access";
import type { VisitorKind } from "@/generated/prisma/enums";

/**
 * The kind of page somebody opened, which is as much of the address as this album keeps. Together with the trip,
 * collection or item it was about, it answers every figure the Admin page shows; the path itself would additionally
 * be a record of where each relative went, and the album has no business holding that.
 */
export const SECTIONS = ["home", "trip", "collection", "item", "timeline", "map", "search", "people", "upload", "other"] as const;
export type Section = (typeof SECTIONS)[number];

export type VisitTarget = { section: Section; tripId?: string; collectionId?: string; photoId?: string; viaShare?: boolean };

/** Pages that are the album being administered rather than the album being looked at, and are never counted. */
const NOT_A_VISIT = [/^\/admin(\/|$)/, /^\/auth(\/|$)/, /^\/invite(\/|$)/, /^\/offline$/, /^\/api(\/|$)/];

export function countable(path: string): boolean {
  return !NOT_A_VISIT.some((re) => re.test(path));
}

/**
 * Something that says it is a robot. Most never run the script that reports a visit at all, so this is only the
 * tail of the distribution: the preview fetchers that do run one, chiefly when a share link is pasted into a chat.
 * Deliberately not matched: "headless", which is every browser this project's own tests drive.
 */
const ROBOT = /bot\b|crawl|spider|slurp|facebookexternalhit|bingpreview|whatsapp|telegrambot|preview/i;

export function looksLikeRobot(userAgent: string | null): boolean {
  return Boolean(userAgent && ROBOT.test(userAgent));
}

/** Where a visitor came from, kept as a bare host so "somebody arrived from Facebook" is answerable. Our own pages are not arrivals. */
export function referrerHost(ref: string | null, appUrl: string): string | null {
  if (!ref) return null;
  try {
    const host = new URL(ref).host.replace(/^www\./, "");
    return host && host !== new URL(appUrl).host ? host.slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** The day a visit is counted under, in the server's own time zone, so "today" on the Admin page means today. */
export function dayKey(at: Date, timeZone = serverTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function serverTimeZone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const saltCache = new Map<string, string>();

/**
 * The salt one day's visitor hashes are made with. It lives in the database rather than in the process so that a
 * restart in the middle of the afternoon does not start counting the same people a second time, and it is deleted
 * along with that day's visits, which is what makes the hashes unrepeatable once they have been purged.
 */
export async function saltFor(day: string): Promise<string> {
  const held = saltCache.get(day);
  if (held) return held;
  const made = randomBytes(32).toString("hex");
  // Two requests arriving together both try to create it; whoever loses the race reads the winner's salt back.
  const row = await db.visitSalt.upsert({ where: { day }, create: { day, salt: made }, update: {}, select: { salt: true } });
  saltCache.set(day, row.salt);
  if (saltCache.size > 8) for (const key of [...saltCache.keys()].sort().slice(0, saltCache.size - 8)) saltCache.delete(key);
  return row.salt;
}

/**
 * How one browser is told from another for a day without keeping anything that identifies it. The address and the
 * browser's own description of itself go in with the day's random salt and only the digest is kept, so the row
 * cannot be turned back into an address, and the same person tomorrow is a different number.
 */
export function visitorHash(salt: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}\n${ip}\n${userAgent}`).digest("hex").slice(0, 32);
}

/** The caller's address as the reverse proxy reports it; the first hop is the visitor, the rest are proxies. */
export function callerAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 64);
  return (headers.get("x-real-ip") ?? "unknown").slice(0, 64);
}

/**
 * The album's own reading of a path: which kind of page, and which trip, collection or item it was about. Slugs and
 * share tokens are resolved here so that nothing recognisable is written down — a share token in particular is a
 * password, and belongs in no table but the one it was issued from.
 */
export async function resolveTarget(path: string): Promise<VisitTarget | null> {
  const clean = path.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "") || "/";
  const parts = clean.split("/").filter(Boolean);
  if (clean === "/") return { section: "home" };

  if (parts[0] === "share") {
    // /share/<token>/... is a trip, /share/c/<token>/... a collection; the token itself is never stored.
    const collection = parts[1] === "c";
    const token = collection ? parts[2] : parts[1];
    const rest = parts.slice(collection ? 3 : 2);
    if (!token) return null;
    if (collection) {
      const found = await db.collection.findUnique({ where: { shareToken: token }, select: { id: true } });
      return found ? { section: sectionOfTab(rest, "collection"), collectionId: found.id, viaShare: true } : null;
    }
    const found = await db.trip.findUnique({ where: { shareToken: token }, select: { id: true } });
    return found ? { section: sectionOfTab(rest, "trip"), tripId: found.id, viaShare: true } : null;
  }

  if (parts[0] === "trips" && parts[1] && parts[1] !== "new") {
    const trip = await db.trip.findUnique({ where: { slug: parts[1] }, select: { id: true } });
    return trip ? { section: sectionOfTab(parts.slice(2), "trip"), tripId: trip.id } : null;
  }

  if (parts[0] === "collections" && parts[1] && parts[1] !== "new") {
    const collection = await db.collection.findUnique({ where: { slug: parts[1] }, select: { id: true } });
    return collection ? { section: sectionOfTab(parts.slice(2), "collection"), collectionId: collection.id } : null;
  }

  if (parts[0] === "photos" && parts[1]) {
    const photo = await db.photo.findUnique({ where: { id: parts[1] }, select: { id: true } });
    return photo ? { section: "item", photoId: photo.id } : null;
  }

  const plain: Record<string, Section> = { photos: "item", timeline: "timeline", map: "map", search: "search", place: "search", people: "people", graph: "people", upload: "upload" };
  return { section: plain[parts[0] ?? ""] ?? "other" };
}

/** Which tab of a trip or collection: its own sub-pages are counted as timeline or map, everything else as the thing itself. */
function sectionOfTab(rest: string[], fallback: Section): Section {
  const tab = rest[0];
  if (tab === "timeline") return "timeline";
  if (tab === "map") return "map";
  return fallback;
}

export type VisitNote = {
  path: string;
  ref: string | null;
  headers: Headers;
  userId: string | null;
  /** Share cookies the browser is carrying, keyed as `auth/access` keys them, so a secret link is only credited for the thing it opens. */
  shareKeys: Set<string>;
};

/**
 * Write down one page opened by one browser, or decide there is nothing to write down. Returns what was recorded
 * so the route (and the tests) can say what happened without reading the table back.
 */
export async function recordVisit(note: VisitNote): Promise<{ recorded: false; why: string } | { recorded: true; kind: VisitorKind; section: Section }> {
  if (!env().VISITOR_STATS_ENABLED) return { recorded: false, why: "off" };
  if (!countable(note.path)) return { recorded: false, why: "not a visit" };
  const userAgent = note.headers.get("user-agent") ?? "";
  if (looksLikeRobot(userAgent)) return { recorded: false, why: "robot" };
  const target = await resolveTarget(note.path);
  if (!target) return { recorded: false, why: "nothing there" };

  const at = new Date();
  const salt = await saltFor(dayKey(at));
  const hash = visitorHash(salt, callerAddress(note.headers), userAgent);
  const held = target.tripId ? note.shareKeys.has(shareKey("trip", target.tripId)) : target.collectionId ? note.shareKeys.has(shareKey("collection", target.collectionId)) : false;
  const kind: VisitorKind = note.userId ? "MEMBER" : target.viaShare || held ? "SHARE" : "PUBLIC";

  // One person reading one page is one visit however many times the page re-renders or they press back: the same
  // browser on the same thing within the quiet minute is already counted.
  const recently = await db.visit.findFirst({
    where: { visitorHash: hash, section: target.section, tripId: target.tripId ?? null, collectionId: target.collectionId ?? null, photoId: target.photoId ?? null, at: { gt: new Date(at.getTime() - 60_000) } },
    select: { id: true },
  });
  if (recently) return { recorded: false, why: "already counted" };

  await db.visit.create({
    data: {
      at,
      kind,
      visitorHash: hash,
      userId: note.userId,
      section: target.section,
      tripId: target.tripId ?? null,
      collectionId: target.collectionId ?? null,
      photoId: target.photoId ?? null,
      refHost: referrerHost(note.ref, env().APP_URL),
    },
  });
  return { recorded: true, kind, section: target.section };
}

/** Visits older than the retention window, and the salts that made their hashes, go together. */
export async function purgeVisits(now = new Date()): Promise<{ visits: number; salts: number }> {
  const days = env().VISITOR_STATS_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const visits = await db.visit.deleteMany({ where: { at: { lt: cutoff } } });
  const salts = await db.visitSalt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  for (const day of saltCache.keys()) if (day < dayKey(cutoff)) saltCache.delete(day);
  return { visits: visits.count, salts: salts.count };
}
