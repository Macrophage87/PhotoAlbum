import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { onThisDay, parseCalendarDay } from "@/lib/photos/on-this-day";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const today = { year: 2026, month: 11, day: 23 };

describe("which day it is, as the browser says", () => {
  it("takes a real calendar day and nothing else", () => {
    expect(parseCalendarDay("2026-11-23")).toEqual({ year: 2026, month: 11, day: 23 });
    expect(parseCalendarDay("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseCalendarDay("2026-02-29")).toBeNull();
    expect(parseCalendarDay("2026-13-01")).toBeNull();
    expect(parseCalendarDay("26-11-23")).toBeNull();
    expect(parseCalendarDay("2026-11-23T00:00")).toBeNull();
    expect(parseCalendarDay(null)).toBeNull();
  });
});

describe("On this day", () => {
  let member: Viewer;
  let uploaderId: string;
  let mk: (takenAt: string, extra?: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "jo@example.com", name: "Jo" } });
    uploaderId = u.id;
    member = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
    let n = 0;
    mk = async (takenAt, extra = {}) =>
      (await db.photo.create({ data: { uploaderId, originalName: `p${++n}.jpg`, mimeType: "image/jpeg", storageKey: `k${n}`, originalPath: `k${n}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 100, takenAt: new Date(takenAt), tzOffsetMin: 0, ...extra } })).id;
  });

  it("finds this day in earlier years, newest year first, and not today or another day", async () => {
    const a = await mk("2023-11-23T10:00:00Z");
    const b = await mk("2019-11-23T18:00:00Z");
    await mk("2026-11-23T09:00:00Z"); // today itself is not a memory yet
    await mk("2023-11-22T10:00:00Z");
    await mk("2023-11-23T10:00:00Z", { status: "PROCESSING" });
    await mk("2023-11-23T10:00:00Z", { trashedAt: new Date() });
    await mk("2023-11-23T10:00:00Z", { kind: "VIDEO" });
    const found = await onThisDay(member, today);
    expect(found.map((p) => [p.id, p.year])).toEqual([[a, 2023], [b, 2019]]);
  });

  it("reads the day on the clock where the photo was taken", async () => {
    // 03:00 UTC on the 24th is the evening of the 23rd in California.
    const evening = await mk("2022-11-24T03:00:00Z", { tzOffsetMin: -480 });
    // 23:00 UTC on the 22nd is already the 23rd in Tokyo.
    const morning = await mk("2022-11-22T23:00:00Z", { tzOffsetMin: 540 });
    const found = await onThisDay(member, today);
    expect(found.map((p) => p.id).sort()).toEqual([evening, morning].sort());
  });

  it("keeps a few from each year, the family's favourites first", async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map((h) => mk(`2021-11-23T0${h}:00:00Z`)));
    await db.photoFavorite.create({ data: { userId: uploaderId, photoId: ids[5] } });
    const found = await onThisDay(member, today, { perYear: 3 });
    expect(found).toHaveLength(3);
    expect(found[0].id).toBe(ids[5]);
  });

  it("shows a visitor only what is public, and never the name of a private trip", async () => {
    const pub = await db.trip.create({ data: { slug: "pub", title: "Public trip", startDate: new Date("2020-11-20"), endDate: new Date("2020-11-25"), createdById: uploaderId, visibility: "PUBLIC" } });
    const priv = await db.trip.create({ data: { slug: "priv", title: "Secret trip", startDate: new Date("2018-11-20"), endDate: new Date("2018-11-25"), createdById: uploaderId, visibility: "PRIVATE" } });
    const inPublic = await mk("2020-11-23T12:00:00Z", { tripId: pub.id });
    const privateOnly = await mk("2018-11-23T12:00:00Z", { tripId: priv.id });
    const viaCollection = await mk("2018-11-23T13:00:00Z", { tripId: priv.id });
    const shown = await db.collection.create({ data: { slug: "c", title: "C", createdById: uploaderId, visibility: "PUBLIC" } });
    await db.collectionItem.create({ data: { collectionId: shown.id, photoId: viaCollection, addedById: uploaderId } });

    const seen = await onThisDay(anon, today);
    expect(seen.map((p) => p.id).sort()).toEqual([inPublic, viaCollection].sort());
    expect(seen.find((p) => p.id === inPublic)?.tripTitle).toBe("Public trip");
    expect(seen.find((p) => p.id === viaCollection)?.tripTitle).toBeNull();
    expect(seen.find((p) => p.id === viaCollection)?.tripSlug).toBeNull();

    const all = await onThisDay(member, today);
    expect(all.map((p) => p.id)).toContain(privateOnly);
    expect(all.find((p) => p.id === privateOnly)?.tripTitle).toBe("Secret trip");
  });
});
