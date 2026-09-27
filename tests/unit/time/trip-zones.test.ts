import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";
import { canonicalTimezone, isValidTimezone, normalizedTimezone, photoDay } from "@/lib/time/local-day";
import { tripInputSchema } from "@/lib/trips/validation";
import { COMMON_ZONES } from "@/components/trips/TripForm";
import { idsInLocalYear } from "@/lib/photos/page";
import { searchFacets, searchMedia } from "@/lib/search/query";
import { inLocalYearSql } from "@/lib/time/local-day-sql";
import { isPhotoYear } from "@/lib/photos/filters";

/**
 * A trip's zone is read twice: by Intl on the pages, and by Postgres in the year filters. The two must agree on
 * every name a trip can be saved under, and a name Postgres does not know must never fail a query (#144).
 */
describe("the zones trips are kept under", () => {
  it("keeps a zone under the tz database's own name and refuses bare offsets", () => {
    expect(canonicalTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(canonicalTimezone("US/Pacific")).toBe("America/Los_Angeles");
    expect(canonicalTimezone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimezone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTimezone("Asia/Saigon")).toBe("Asia/Ho_Chi_Minh");
    expect(canonicalTimezone("Etc/GMT+12")).toBe("Etc/GMT+12");
    expect(canonicalTimezone("GMT")).toBe("UTC");
    for (const offset of ["+05:00", "-08:00", "+0530", "Atlantis/Lost"]) expect(isValidTimezone(offset)).toBe(false);
  });

  it("saves a trip under the new name, and refuses an offset", () => {
    const trip = { title: "Goa", startDate: "2025-12-29", endDate: "2026-01-02", themeKey: "default" };
    expect(tripInputSchema.parse({ ...trip, timezone: "Asia/Calcutta" }).timezone).toBe("Asia/Kolkata");
    expect(tripInputSchema.safeParse({ ...trip, timezone: "+05:00" }).success).toBe(false);
  });

  it("gives every zone a browser knows, and every zone the trip form offers, a name this Postgres knows", async () => {
    const known = new Set((await db.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`).map((r) => r.name));
    const unknown = Intl.supportedValuesOf("timeZone").map((z) => canonicalTimezone(z)).filter((z) => !z || !known.has(z));
    expect(unknown).toEqual([]);
    expect(COMMON_ZONES.filter((z) => canonicalTimezone(z) !== z || !known.has(z))).toEqual([]);
  });

  it("turns an offset into the fixed-offset zone that says the same, and anything else into UTC", () => {
    expect(normalizedTimezone("+05:00")).toBe("Etc/GMT-5");
    expect(normalizedTimezone("-08:00")).toBe("Etc/GMT+8");
    expect(normalizedTimezone("+00:00")).toBe("UTC");
    expect(normalizedTimezone("+05:30")).toBe("UTC");
    expect(normalizedTimezone("Atlantis/Lost")).toBe("UTC");
    expect(normalizedTimezone("Europe/Kiev")).toBe("Europe/Kyiv");
  });
});

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

describe("trips saved under a name Postgres reads differently or not at all", () => {
  let dana: string, member: Viewer;
  const trip = (slug: string, timezone: string) => db.trip.create({ data: { slug, title: slug, timezone, startDate: new Date("2025-12-29"), endDate: new Date("2026-01-02"), createdById: dana } });
  /** 11:30 PM on New Year's Eve in Los Angeles, no offset of its own. */
  const photo = (tripId: string, caption: string, takenAt = new Date("2026-01-01T07:30:00Z")) =>
    db.photo.create({ data: { uploaderId: dana, tripId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", caption, takenAt, tzOffsetMin: null } });

  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    dana = u.id;
    member = { kind: "user", user: { id: dana, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
  });

  it("reads a trip saved under an old name Postgres may not know in the zone it names, and anything else as UTC", async () => {
    // 11:30 PM on New Year's Eve in Buenos Aires, three hours west: already 1 January in UTC.
    const ba = await photo((await trip("ba", "America/Buenos_Aires")).id, "Fireworks over the river", new Date("2026-01-01T02:30:00Z"));
    const lost = await photo((await trip("lost", "Atlantis/Lost")).id, "Fireworks over the reef");
    expect(photoDay(ba.takenAt!, null, "America/Buenos_Aires")).toBe("2025-12-31");
    expect(await idsInLocalYear(null, 2025)).toEqual([ba.id]);
    expect(await idsInLocalYear(ba.tripId, 2025)).toEqual([ba.id]);
    expect(await idsInLocalYear(null, 2026)).toEqual([lost.id]);
    expect((await searchFacets(member)).years).toEqual([2026, 2025]);
    expect((await searchFacets(anon)).years).toEqual([]);
    expect((await searchMedia(member, { q: "fireworks", year: 2025 }, 120, null)).map((h) => h.id)).toEqual([ba.id]);
    expect((await searchMedia(member, { q: "fireworks", year: 2026 }, 120, null)).map((h) => h.id)).toEqual([lost.id]);
  });

  it("renames trips saved under an old name or a bare offset, in the migration", async () => {
    const saved = { goa: "Asia/Calcutta", ba: "America/Buenos_Aires", sf: "US/Pacific", east: "+05:00", west: "-0800", half: "+05:30", zero: "+00", la: "America/Los_Angeles" };
    for (const [slug, tz] of Object.entries(saved)) await trip(slug, tz);
    const migration = readFileSync(path.join(process.cwd(), "prisma/migrations/20260927160000_trip_timezone_names/migration.sql"), "utf8");
    for (const statement of migration.replace(/^--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    const now = Object.fromEntries((await db.trip.findMany({ select: { slug: true, timezone: true } })).map((t) => [t.slug, t.timezone]));
    expect(now).toEqual({ goa: "Asia/Kolkata", ba: "America/Argentina/Buenos_Aires", sf: "America/Los_Angeles", east: "Etc/GMT-5", west: "Etc/GMT+8", half: "UTC", zero: "UTC", la: "America/Los_Angeles" });
    // The migration and the SQL's own reading of a zone Postgres does not know say the same.
    for (const [slug, tz] of Object.entries(saved)) expect([slug, normalizedTimezone(tz)]).toEqual([slug, now[slug]]);
    // 7:30 PM UTC on New Year's Eve is already 1 January five hours east: the pages and the SQL both say so.
    const east = await photo((await db.trip.findUniqueOrThrow({ where: { slug: "east" } })).id, "Midnight", new Date("2025-12-31T19:30:00Z"));
    expect(photoDay(east.takenAt!, null, now.east)).toBe("2026-01-01");
    expect(await idsInLocalYear(east.tripId, 2026)).toEqual([east.id]);
  });

  it("answers a year no timestamp can hold with nothing, not an error", async () => {
    await photo((await trip("la", "America/Los_Angeles")).id, "Fireworks over the pier");
    expect(await searchMedia(member, { q: "fireworks", year: 1e12 }, 120, null)).toEqual([]);
    expect(await idsInLocalYear(null, 99_999)).toEqual([]);
    expect(inLocalYearSql(-5, []).sql).toBe("FALSE");
    // And the search page never asks: it takes the galleries' range of years.
    expect([isPhotoYear(1826), isPhotoYear(2200), isPhotoYear(1825), isPhotoYear(2201), isPhotoYear(1e12)]).toEqual([true, true, false, false, false]);
  });
});
