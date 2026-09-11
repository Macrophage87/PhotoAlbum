import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { normalizeQuery, searchFacets, searchMedia } from "@/lib/search/query";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
let member: Viewer;

async function photo(data: { tripId: string | null; uploaderId: string; caption?: string; context?: string; title?: string; takenAt?: Date }) {
  return db.photo.create({ data: { originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
}

describe("keyword search", () => {
  let publicTrip: string, privateTrip: string, dana: string;
  beforeAll(async () => {
    await resetTestDb();
    // "Dana" appears only in the User row, never in a caption, context or title, so the anonymous column cannot carry it.
    const user = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    dana = user.id;
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    publicTrip = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), visibility: "PUBLIC", createdById: dana } })).id;
    privateTrip = (await db.trip.create({ data: { slug: "lake", title: "Lake House 2019", startDate: new Date("2019-07-01"), endDate: new Date("2019-07-08"), createdById: dana } })).id;
    await photo({ tripId: publicTrip, uploaderId: dana, caption: "Lunch on the Ranger", context: "lobster rolls on the mail boat", takenAt: new Date("2025-08-12T12:00:00Z") });
    await photo({ tripId: privateTrip, uploaderId: dana, caption: "Kate with a lobster roll", takenAt: new Date("2019-07-03T12:00:00Z") });
    const noTrip = await photo({ tripId: null, uploaderId: dana, title: "Dock at Bar Harbor" });
    const col = await db.collection.create({ data: { slug: "favourites", title: "Summer Favourites", visibility: "PUBLIC", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: col.id, photoId: noTrip.id, addedById: dana } });
  });

  it("normalises the query", () => {
    expect(normalizeQuery("  lobster   roll ")).toBe("lobster roll");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(200);
  });

  it("ranks matches across caption and context and marks the snippet", async () => {
    const hits = await searchMedia(member, { q: "lobster" });
    expect(hits.map((h) => h.caption).sort()).toEqual(["Kate with a lobster roll", "Lunch on the Ranger"]);
    expect(hits.every((h) => h.snippet.includes("[[lobster]]"))).toBe(true);
  });

  it("anonymous visitors see only public content, including private-trip photos in a public collection", async () => {
    expect((await searchMedia(anon, { q: "lobster" })).map((h) => h.caption)).toEqual(["Lunch on the Ranger"]);
    expect((await searchMedia(anon, { q: "dock" })).map((h) => h.title)).toEqual(["Dock at Bar Harbor"]);
    expect((await searchMedia(anon, { q: "harbor" }))[0].uploaderName).toBeNull();
  });

  it("finds by trip and collection title", async () => {
    expect((await searchMedia(member, { q: "Acadia" })).length).toBe(1);
    expect((await searchMedia(member, { q: "favourites" })).map((h) => h.title)).toEqual(["Dock at Bar Harbor"]);
  });

  it("never lets a name enter the anonymous ranking path", async () => {
    expect(await searchMedia(anon, { q: "Dana" })).toEqual([]);
    expect((await searchMedia(member, { q: "Dana" })).length).toBe(3);
  });

  it("applies filters and builds facets from the visible set only", async () => {
    expect((await searchMedia(member, { q: "lobster", year: 2019 })).map((h) => h.caption)).toEqual(["Kate with a lobster roll"]);
    expect((await searchMedia(member, { q: "lobster", tripId: publicTrip })).length).toBe(1);
    expect((await searchMedia(member, { q: "lobster", kind: "VIDEO" })).length).toBe(0);
    const f = await searchFacets(anon);
    expect(f.trips.map((t) => t.title)).toEqual(["Acadia"]);
    expect(f.uploaders).toEqual([]);
    expect(f.years).toEqual([2025]);
    expect((await searchFacets(member)).uploaders.map((u) => u.name)).toEqual(["Dana"]);
  });
});
