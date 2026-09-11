import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchMedia } from "@/lib/search/query";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
let member: Viewer;

/**
 * The names live only in Person rows: never in a caption, note or title. The photos are on a PUBLIC trip so the
 * anonymous visitor could see them; only the name must stay invisible.
 */
describe("people names in search", () => {
  let adultPhoto: string, childPhoto: string;
  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "m@example.com", name: "M", role: "MEMBER" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    const trip = await db.trip.create({ data: { slug: "pub", title: "Public trip", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), visibility: "PUBLIC", createdById: user.id } });
    const base = { tripId: trip.id, uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
    adultPhoto = (await db.photo.create({ data: { ...base, caption: "Lunch by the water" } })).id;
    childPhoto = (await db.photo.create({ data: { ...base, caption: "Sandcastles" } })).id;
    // An adult with recognition off, and a minor: both searchable by members, neither by anyone else.
    const marguerite = await db.person.create({ data: { name: "Marguerite Hastings", birthday: new Date("1970-01-01"), faceIndexing: false, createdById: user.id } });
    const child = await db.person.create({ data: { name: "Theodore", birthday: new Date("2019-05-01"), createdById: user.id } });
    await db.face.create({ data: { photoId: adultPhoto, personId: marguerite.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await db.face.create({ data: { photoId: childPhoto, personId: child.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0.9 } });
  });

  it("returns nothing for an anonymous search by name, and the photos for a member", async () => {
    expect(await searchMedia(anon, { q: "Marguerite" }, 20, null)).toEqual([]);
    expect((await searchMedia(member, { q: "Marguerite" }, 20, null)).map((h) => h.id)).toEqual([adultPhoto]);
  });

  it("finds a child by name for a member only, and surnames the stemmer would alter", async () => {
    expect(await searchMedia(anon, { q: "Theodore" }, 20, null)).toEqual([]);
    expect((await searchMedia(member, { q: "Theodore" }, 20, null)).map((h) => h.id)).toEqual([childPhoto]);
    expect((await searchMedia(member, { q: "Hastings" }, 20, null)).map((h) => h.id)).toEqual([adultPhoto]);
  });

  it("drops a person from the members' index once they opt out but keep their name on photos", async () => {
    await db.person.updateMany({ where: { name: "Marguerite Hastings" }, data: { optedOutAt: new Date() } });
    await db.photo.update({ where: { id: adultPhoto }, data: { updatedAt: new Date() } });
    expect(await searchMedia(member, { q: "Marguerite" }, 20, null)).toEqual([]);
  });
});
