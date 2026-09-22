import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  callerAddress,
  countable,
  dayKey,
  looksLikeRobot,
  purgeVisits,
  recordVisit,
  referrerHost,
  resolveTarget,
  visitorHash,
} from "@/lib/visits/record";
import { fillGaps, visitorStats } from "@/lib/visits/stats";
import { barLabel, plural, whenAgo } from "@/lib/visits/format";
import { resetTestDb } from "../helpers/reset";

const headers = (init: Record<string, string> = {}) => new Headers({ "user-agent": "Mozilla/5.0 (a laptop)", "x-forwarded-for": "198.51.100.7", ...init });
const note = (path: string, over: Partial<Parameters<typeof recordVisit>[0]> = {}) => ({ path, ref: null, headers: headers(), userId: null, shareKeys: new Set<string>(), ...over });

describe("what counts as a visit at all", () => {
  it("counts the album being looked at, not the album being administered", () => {
    expect(countable("/")).toBe(true);
    expect(countable("/trips/acadia/photos")).toBe(true);
    expect(countable("/admin")).toBe(false);
    expect(countable("/admin/trash")).toBe(false);
    // Signing in is not a visit, and neither is the page shown when the connection is gone.
    expect(countable("/auth/signin")).toBe(false);
    expect(countable("/invite/abc")).toBe(false);
    expect(countable("/offline")).toBe(false);
  });

  it("knows the preview fetchers that follow a pasted link, and leaves real browsers alone", () => {
    expect(looksLikeRobot("facebookexternalhit/1.1")).toBe(true);
    expect(looksLikeRobot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(looksLikeRobot("WhatsApp/2.23")).toBe(true);
    expect(looksLikeRobot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
    // The browser this project's own tests drive says "Headless", which is not a robot for our purposes.
    expect(looksLikeRobot("Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36")).toBe(false);
    expect(looksLikeRobot(null)).toBe(false);
  });

  it("keeps the bare host of whatever linked here, and does not count our own pages as an arrival", () => {
    expect(referrerHost("https://www.facebook.com/somebody/posts/123", "https://album.example")).toBe("facebook.com");
    expect(referrerHost("https://album.example/trips/acadia", "https://album.example")).toBe(null);
    expect(referrerHost("not a url", "https://album.example")).toBe(null);
    expect(referrerHost(null, "https://album.example")).toBe(null);
  });

  it("reads the visitor's address from the first hop the proxy names, never the proxies behind it", () => {
    expect(callerAddress(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1, 10.0.0.2" }))).toBe("198.51.100.7");
    expect(callerAddress(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(callerAddress(new Headers())).toBe("unknown");
  });
});

describe("telling one browser from another without keeping anything that identifies it", () => {
  it("gives the same browser the same number for a day, and a different one under tomorrow's salt", () => {
    const today = visitorHash("salt-of-monday", "198.51.100.7", "a laptop");
    expect(visitorHash("salt-of-monday", "198.51.100.7", "a laptop")).toBe(today);
    expect(visitorHash("salt-of-tuesday", "198.51.100.7", "a laptop")).not.toBe(today);
    expect(visitorHash("salt-of-monday", "198.51.100.8", "a laptop")).not.toBe(today);
    expect(visitorHash("salt-of-monday", "198.51.100.7", "a phone")).not.toBe(today);
    // Not reversible, and not the address in any form.
    expect(today).not.toContain("198");
    expect(today).toMatch(/^[0-9a-f]{32}$/);
  });

  it("counts a visit under the day it is in where the server stands", () => {
    const newYearMorningInLondon = new Date("2026-01-01T00:30:00Z");
    expect(dayKey(newYearMorningInLondon, "Europe/London")).toBe("2026-01-01");
    // The same moment is still the old year in New York, and is counted there as the 31st.
    expect(dayKey(newYearMorningInLondon, "America/New_York")).toBe("2025-12-31");
  });
});

describe("reading a path without writing it down", () => {
  let me: string, tripId: string, collectionId: string, photoId: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me, visibility: "LINK", shareToken: "secret-trip-token" } })).id;
    collectionId = (await db.collection.create({ data: { slug: "best", title: "Best of", createdById: me, visibility: "LINK", shareToken: "secret-collection-token" } })).id;
    photoId = (await db.photo.create({ data: { tripId, uploaderId: me, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  });

  it("turns a trip's pages into the trip and the kind of page", async () => {
    expect(await resolveTarget("/trips/acadia")).toEqual({ section: "trip", tripId });
    expect(await resolveTarget("/trips/acadia/photos")).toEqual({ section: "trip", tripId });
    expect(await resolveTarget("/trips/acadia/timeline")).toEqual({ section: "timeline", tripId });
    expect(await resolveTarget("/trips/acadia/map?zoom=4")).toEqual({ section: "map", tripId });
  });

  it("turns a secret link into the thing it opens, and never keeps the token", async () => {
    expect(await resolveTarget("/share/secret-trip-token")).toEqual({ section: "trip", tripId, viaShare: true });
    expect(await resolveTarget("/share/secret-trip-token/map")).toEqual({ section: "map", tripId, viaShare: true });
    expect(await resolveTarget("/share/c/secret-collection-token")).toEqual({ section: "collection", collectionId, viaShare: true });
  });

  it("recognizes collections, single photographs and the plain pages", async () => {
    expect(await resolveTarget("/collections/best")).toEqual({ section: "collection", collectionId });
    expect(await resolveTarget(`/photos/${photoId}`)).toEqual({ section: "item", photoId });
    expect(await resolveTarget("/")).toEqual({ section: "home" });
    expect(await resolveTarget("/search?q=kayak")).toEqual({ section: "search" });
    expect(await resolveTarget("/timeline")).toEqual({ section: "timeline" });
  });

  it("writes nothing down for a thing that is not there", async () => {
    expect(await resolveTarget("/trips/no-such-trip")).toBe(null);
    expect(await resolveTarget("/share/not-a-token")).toBe(null);
    expect(await resolveTarget("/photos/not-an-id")).toBe(null);
  });
});

describe("writing a visit down", () => {
  let me: string, tripId: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me, visibility: "LINK", shareToken: "secret-trip-token" } })).id;
  });

  it("tells a member, a secret link and a passer-by apart", async () => {
    expect(await recordVisit(note("/trips/acadia", { userId: me }))).toMatchObject({ recorded: true, kind: "MEMBER" });
    expect(await recordVisit(note("/share/secret-trip-token", { headers: headers({ "x-forwarded-for": "198.51.100.8" }) }))).toMatchObject({ recorded: true, kind: "SHARE" });
    expect(await recordVisit(note("/trips/acadia", { headers: headers({ "x-forwarded-for": "198.51.100.9" }) }))).toMatchObject({ recorded: true, kind: "PUBLIC" });
  });

  it("credits a secret link only for the thing that link opens", async () => {
    const other = await db.trip.create({ data: { slug: "yosemite", title: "Yosemite", startDate: new Date("2025-09-01"), endDate: new Date("2025-09-05"), createdById: me, visibility: "PUBLIC" } });
    // The browser holds a cookie for Acadia; reading the public Yosemite pages is not a visit on that link.
    const holding = new Set([`trip_${tripId}`]);
    expect(await recordVisit(note("/trips/acadia", { shareKeys: holding }))).toMatchObject({ kind: "SHARE" });
    expect(await recordVisit(note("/trips/yosemite", { shareKeys: holding }))).toMatchObject({ kind: "PUBLIC" });
    expect(await db.visit.count({ where: { tripId: other.id, kind: "PUBLIC" } })).toBe(1);
  });

  it("keeps the section and the thing, and neither the path nor the token nor the address", async () => {
    await recordVisit(note("/share/secret-trip-token/map", { ref: "https://www.facebook.com/a/post" }));
    const [row] = await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "Visit"`;
    const everything = JSON.stringify(row);
    expect(everything).not.toContain("secret-trip-token");
    expect(everything).not.toContain("198.51.100.7");
    expect(everything).not.toContain("/share/");
    expect(row).toMatchObject({ section: "map", tripId, kind: "SHARE", refHost: "facebook.com" });
  });

  it("counts one page once however many times the browser reports it", async () => {
    expect(await recordVisit(note("/trips/acadia"))).toMatchObject({ recorded: true });
    expect(await recordVisit(note("/trips/acadia"))).toMatchObject({ recorded: false, why: "already counted" });
    // A different page in the same breath is a different look.
    expect(await recordVisit(note("/trips/acadia/map"))).toMatchObject({ recorded: true });
    expect(await db.visit.count()).toBe(2);
  });

  it("writes nothing down for the admin's own pages or for a preview fetcher", async () => {
    expect(await recordVisit(note("/admin", { userId: me }))).toMatchObject({ recorded: false, why: "not a visit" });
    expect(await recordVisit(note("/trips/acadia", { headers: headers({ "user-agent": "facebookexternalhit/1.1" }) }))).toMatchObject({ recorded: false, why: "robot" });
    expect(await db.visit.count()).toBe(0);
  });

  it("throws away old visits along with the salt that made their numbers unrepeatable", async () => {
    await recordVisit(note("/trips/acadia"));
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await db.visit.updateMany({ data: { at: old } });
    await db.visitSalt.create({ data: { day: "2020-01-01", salt: "long ago", createdAt: old } });
    const report = await purgeVisits();
    expect(report.visits).toBe(1);
    expect(await db.visit.count()).toBe(0);
    expect(await db.visitSalt.count({ where: { day: "2020-01-01" } })).toBe(0);
  });
});

describe("what the Admin page is told", () => {
  let me: string, tripId: string;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me, visibility: "LINK", shareToken: "secret-trip-token" } })).id;
  });

  it("counts pages and browsers, splits them by who was looking, and names the trip they came for", async () => {
    await recordVisit(note("/trips/acadia", { userId: me }));
    await recordVisit(note("/trips/acadia/map", { userId: me }));
    await recordVisit(note("/share/secret-trip-token", { headers: headers({ "x-forwarded-for": "198.51.100.8" }), ref: "https://www.facebook.com/x" }));
    await recordVisit(note("/share/secret-trip-token/map", { headers: headers({ "x-forwarded-for": "198.51.100.8" }) }));

    const stats = await visitorStats(30);
    expect(stats.totals.visits).toBe(4);
    // Two addresses, so two browsers, however many pages each of them opened.
    expect(stats.totals.visitors).toBe(2);
    expect(stats.byKind.find((k) => k.kind === "MEMBER")).toMatchObject({ visits: 2, visitors: 1 });
    expect(stats.byKind.find((k) => k.kind === "SHARE")).toMatchObject({ visits: 2, visitors: 1 });
    expect(stats.trips).toHaveLength(1);
    expect(stats.trips[0]).toMatchObject({ id: tripId, title: "Acadia", visits: 4, visitors: 2, shareVisits: 2 });
    expect(stats.referrers).toEqual([{ host: "facebook.com", visits: 1 }]);
    expect(stats.members.find((m) => m.id === me)).toMatchObject({ visits: 2 });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.at(-1)).toMatchObject({ visits: 4 });
  });

  it("leaves out what happened before the window", async () => {
    await recordVisit(note("/trips/acadia"));
    await db.visit.updateMany({ data: { at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
    expect((await visitorStats(30)).totals.visits).toBe(0);
    expect((await visitorStats(90)).totals.visits).toBe(1);
  });

  it("says nothing happened when nothing has", async () => {
    const stats = await visitorStats(7);
    expect(stats.totals).toEqual({ visits: 0, visitors: 0 });
    expect(stats.trips).toEqual([]);
    expect(stats.daily).toHaveLength(7);
    // Every member is listed even when none of them has read anything, which is itself the answer.
    expect(stats.members.map((m) => m.last)).toEqual([null]);
  });
});

describe("the chart and the words around it", () => {
  it("gives the chart every day in order, including the ones nobody looked", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const filled = fillGaps([{ day: "2026-03-09", visits: 4, visitors: 2 }], 3, "UTC", now);
    expect(filled).toEqual([
      { day: "2026-03-08", visits: 0, visitors: 0 },
      { day: "2026-03-09", visits: 4, visitors: 2 },
      { day: "2026-03-10", visits: 0, visitors: 0 },
    ]);
  });

  it("says how long ago in the words a family would use", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    expect(whenAgo(null, now)).toBe("never");
    expect(whenAgo(new Date("2026-03-10T11:59:30Z"), now)).toBe("just now");
    expect(whenAgo(new Date("2026-03-10T11:30:00Z"), now)).toBe("30 minutes ago");
    expect(whenAgo(new Date("2026-03-10T09:00:00Z"), now)).toBe("3 hours ago");
    expect(whenAgo(new Date("2026-03-09T12:00:00Z"), now)).toBe("yesterday");
    expect(whenAgo(new Date("2026-03-01T12:00:00Z"), now)).toBe("9 days ago");
    expect(whenAgo(new Date("2026-01-10T12:00:00Z"), now)).toBe("2 months ago");
  });

  it("counts things in English", () => {
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(2, "page")).toBe("2 pages");
    expect(plural(1, "browser")).toBe("1 browser");
    expect(barLabel("2026-03-09")).toBe("9 Mar");
  });
});
