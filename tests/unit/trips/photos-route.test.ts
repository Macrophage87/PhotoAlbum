import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Viewer } from "@/lib/auth/viewer";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET } from "@/app/api/trips/[slug]/photos/route";
import { db } from "@/lib/db";
import { shareKey } from "@/lib/auth/access";
import { resetTestDb } from "../helpers/reset";

const ask = (slug: string, query: string) => GET(new NextRequest(`http://album.test/api/trips/${slug}/photos?${query}`), { params: Promise.resolve({ slug }) } as never);
const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });

describe("re-reading a gallery's photos by id (#111)", () => {
  let userId: string, tripId: string, own: string, unasked: string, processing: string, trashed: string, elsewhere: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "r@example.com", name: "Rita", role: "ADMIN" } });
    userId = user.id;
    const trip = await db.trip.create({ data: { slug: "linked", title: "Linked", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "LINK", shareToken: "tok" } });
    tripId = trip.id;
    const other = await db.trip.create({ data: { slug: "other", title: "Other", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PUBLIC" } });
    const mk = (name: string, onTrip: string, extra: Record<string, unknown> = {}) => db.photo.create({ data: { tripId: onTrip, uploaderId: user.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...extra } });
    own = (await mk("own.jpg", tripId)).id;
    // Live and on the trip, but not named: a route that ignored `ids` would send it back too.
    unasked = (await mk("unasked.jpg", tripId)).id;
    processing = (await mk("processing.jpg", tripId, { status: "PROCESSING" })).id;
    trashed = (await mk("trashed.jpg", tripId, { trashedAt: new Date() })).id;
    elsewhere = (await mk("elsewhere.jpg", other.id)).id;
    // Members-only things the answer must not carry to a visitor: a collection and a heart.
    const collection = await db.collection.create({ data: { slug: "best", title: "Best", createdById: user.id } });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: own, addedById: user.id } });
    await db.photoFavorite.create({ data: { userId: user.id, photoId: own } });
  });

  it("gives a link holder only the trip's own live photo, with nothing members-only on it", async () => {
    who.viewer = anon([[shareKey("trip", tripId), "tok"]]);
    const res = await ask("linked", `ids=${own},${trashed},${elsewhere}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos.map((p: { id: string }) => p.id)).toEqual([own]);
    expect(body.photos.map((p: { id: string }) => p.id)).not.toContain(unasked);
    expect(body.nextCursor).toBeNull();
    const [p] = body.photos;
    expect(p.favourite).toBeNull();
    expect(p.uploadedBy).toBeNull();
    expect(p.collections).toEqual([]);
  });

  it("answers a signed-in member on a share page the way that page draws its first page: no hearts, names or collections", async () => {
    who.viewer = { kind: "user", user: { id: userId, email: "r@example.com", name: "Rita", role: "ADMIN" }, shareTokens: new Map() };
    const [p] = (await (await ask("linked", `view=share&ids=${own}`)).json()).photos;
    expect(p.favourite).toBeNull();
    expect(p.uploadedBy).toBeNull();
    expect(p.collections).toEqual([]);
    // In the members' own gallery the same photo carries all three.
    const [m] = (await (await ask("linked", `ids=${own}`)).json()).photos;
    expect(m.favourite).toEqual({ mine: true, count: 1 });
    expect(m.uploadedBy).toBe("Rita");
    expect(m.collections).toEqual([{ slug: "best", title: "Best" }]);
  });

  it("is not found for a private trip, or a link trip without its cookie", async () => {
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } });
    who.viewer = anon([[shareKey("trip", tripId), "tok"]]);
    expect((await ask("linked", `ids=${own}`)).status).toBe(404);
    await db.trip.update({ where: { id: tripId }, data: { visibility: "LINK" } });
    who.viewer = anon();
    expect((await ask("linked", `ids=${own}`)).status).toBe(404);
  });

  it("shows a visitor, and anyone on a share page, finished items only, by cursor or by id, as the share page does (#141)", async () => {
    const ids = (r: { photos: { id: string }[] }) => r.photos.map((p) => p.id).sort();
    who.viewer = anon([[shareKey("trip", tripId), "tok"]]);
    expect(ids(await (await ask("linked", "")).json())).toEqual([own, unasked].sort());
    expect(ids(await (await ask("linked", `ids=${own},${processing}`)).json())).toEqual([own]);
    who.viewer = { kind: "user", user: { id: userId, email: "r@example.com", name: "Rita", role: "ADMIN" }, shareTokens: new Map() };
    expect(ids(await (await ask("linked", "view=share")).json())).toEqual([own, unasked].sort());
    expect(ids(await (await ask("linked", `view=share&ids=${processing}`)).json())).toEqual([]);
    // A member's own gallery still shows what is on its way, so they can see their upload is there.
    expect(ids(await (await ask("linked", "")).json())).toEqual([own, unasked, processing].sort());
  });

  it("never matches a visitor's words against the names of the people in a photo (#142)", async () => {
    const person = await db.person.create({ data: { name: "Marguerite Hastings", birthday: new Date("1970-01-01"), createdById: userId } });
    await db.face.create({ data: { photoId: own, personId: person.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await db.photo.update({ where: { id: own }, data: { updatedAt: new Date() } });
    const found = async (query: string) => ((await (await ask("linked", query)).json()).photos as { id: string }[]).map((p) => p.id);
    who.viewer = anon([[shareKey("trip", tripId), "tok"]]);
    expect(await found("q=Marguerite")).toEqual([]);
    who.viewer = { kind: "user", user: { id: userId, email: "r@example.com", name: "Rita", role: "ADMIN" }, shareTokens: new Map() };
    expect(await found("view=share&q=Marguerite")).toEqual([]);
    expect(await found("q=Marguerite")).toEqual([own]);
  });
});
