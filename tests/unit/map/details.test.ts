import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET } from "@/app/api/map/photos/route";
import { shareKey } from "@/lib/auth/access";
import type { MapPhotoDetail } from "@/lib/map/details";
import { MAX_DESCRIBED } from "@/lib/map/view";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const anon = (held: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(held) });

/**
 * A map's pins carry only where and when; what a photograph is (its picture, caption, activity and uploader) is asked
 * for when it is clicked. That question is answered photograph by photograph, by the rule the picture itself follows.
 */
describe("what a clicked pin may say", () => {
  let member: Viewer;
  const id: Record<string, string> = {};
  let tripIds: Record<string, string>, activityId: string, linkCollectionId: string;

  const ask = async (ids: string[], query = "") => {
    const res = await GET(new Request(`http://album.test/api/map/photos?ids=${ids.join(",")}${query}`));
    return { status: res.status, photos: res.status === 200 ? ((await res.json()).photos as MapPhotoDetail[]) : [] };
  };
  const described = async (ids: string[], query = "") => (await ask(ids, query)).photos.map((p) => p.id).sort();

  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "gwen@example.com", name: "Gwen", role: "MEMBER" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    const trip = async (slug: string, visibility: "PUBLIC" | "PRIVATE" | "LINK", shareToken: string | null = null) =>
      (await db.trip.create({ data: { slug, title: `Trip ${slug}`, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility, shareToken } })).id;
    tripIds = { open: await trip("open", "PUBLIC"), shut: await trip("shut", "PRIVATE"), linked: await trip("linked", "LINK", "ttok") };
    activityId = (await db.activity.create({ data: { tripId: tripIds.shut, title: "Chemo, second round", startTime: new Date("2025-08-11T10:00:00Z"), endTime: new Date("2025-08-11T12:00:00Z"), shareToken: "atok" } })).id;
    const photo = async (name: string, data: Record<string, unknown>) => {
      id[name] = (await db.photo.create({ data: { originalName: `${name}.jpg`, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", uploaderId: user.id, lat: 44, lng: -68, caption: `The ${name} one`, ...data } })).id;
    };
    await photo("open", { tripId: tripIds.open });
    await photo("shut", { tripId: tripIds.shut });
    await photo("linked", { tripId: tripIds.linked });
    await photo("trashed", { tripId: tripIds.open, trashedAt: new Date(), trashedById: user.id, trashReason: "BLURRY" });
    await photo("unfinished", { tripId: tripIds.open, status: "PROCESSING" });
    await photo("collected", { tripId: tripIds.shut });
    await photo("onActivity", { tripId: tripIds.shut, activityId });
    await photo("linkCollected", { tripId: tripIds.shut });
    const open = await db.collection.create({ data: { slug: "views", title: "Views", visibility: "PUBLIC", createdById: user.id } });
    await db.collectionItem.create({ data: { collectionId: open.id, photoId: id.collected, addedById: user.id } });
    linkCollectionId = (await db.collection.create({ data: { slug: "secret", title: "Secret", visibility: "LINK", shareToken: "ctok", createdById: user.id } })).id;
    await db.collectionItem.create({ data: { collectionId: linkCollectionId, photoId: id.linkCollected, addedById: user.id } });
  });

  it("describes to a visitor only what is in a public trip or collection, and names nobody", async () => {
    who.viewer = anon();
    expect(await described(Object.values(id))).toEqual([id.open, id.collected].sort());
    const { photos } = await ask([id.open, id.collected]);
    const open = photos.find((p) => p.id === id.open)!;
    expect(open).toMatchObject({ caption: "The open one", trip: { slug: "open", title: "Trip open" }, uploadedBy: null });
    expect(open.thumbUrl).toMatch(new RegExp(`^/api/photos/${id.open}/thumb\\?v=`));
    // Reached through a public collection, a private trip's photograph is described without its trip or its activity.
    expect(photos.find((p) => p.id === id.collected)).toMatchObject({ trip: null, activityTitle: null, uploadedBy: null });
  });

  it("answers a private photograph exactly as it answers one that does not exist", async () => {
    who.viewer = anon();
    expect(await ask([id.shut])).toEqual({ status: 200, photos: [] });
    expect(await ask(["nosuchphoto"])).toEqual({ status: 200, photos: [] });
  });

  it("lets a link's holder see what the link opens, and nothing else of the album", async () => {
    who.viewer = anon([[shareKey("trip", tripIds.linked), "ttok"]]);
    expect(await described(Object.values(id))).toEqual([id.open, id.collected, id.linked].sort());
    expect((await ask([id.linked])).photos[0]).toMatchObject({ trip: { slug: "linked" }, uploadedBy: null });
    // A cookie that does not match the trip's link opens nothing.
    who.viewer = anon([[shareKey("trip", tripIds.linked), "wrong"]]);
    expect(await described([id.linked])).toEqual([]);
    who.viewer = anon([[shareKey("collection", linkCollectionId), "ctok"]]);
    expect((await ask([id.linkCollected])).photos[0]).toMatchObject({ trip: null, uploadedBy: null });
  });

  it("names an activity to whoever holds its link, but not the private trip around it", async () => {
    who.viewer = anon([[shareKey("activity", activityId), "atok"]]);
    expect(await described([id.onActivity, id.shut])).toEqual([id.onActivity]);
    expect((await ask([id.onActivity])).photos[0]).toMatchObject({ activityTitle: "Chemo, second round", trip: null, uploadedBy: null });
  });

  it("describes nothing in the trash or still being processed, to a member either", async () => {
    for (const viewer of [anon(), member]) {
      who.viewer = viewer;
      expect(await described([id.trashed, id.unfinished])).toEqual([]);
    }
  });

  it("tells a member everything, and a member reading a shared link's map what its visitors see", async () => {
    who.viewer = member;
    expect(await described(Object.values(id))).toEqual([id.open, id.shut, id.linked, id.collected, id.onActivity, id.linkCollected].sort());
    expect((await ask([id.onActivity])).photos[0]).toMatchObject({ activityTitle: "Chemo, second round", trip: { slug: "shut" }, uploadedBy: "Gwen" });
    // Answered as a visitor without the activity's link: the activity is not named either.
    expect((await ask([id.onActivity], "&view=share")).photos[0]).toMatchObject({ trip: null, activityTitle: null, uploadedBy: null });
    expect((await ask([id.linked], "&view=share")).photos[0]).toMatchObject({ uploadedBy: null });
  });

  it("refuses a question that is not a list of photographs, or too long a list", async () => {
    who.viewer = member;
    expect((await ask([])).status).toBe(400);
    expect((await ask(Array.from({ length: MAX_DESCRIBED + 1 }, (_, i) => `p${i}`))).status).toBe(400);
    expect((await ask(["x".repeat(65)])).status).toBe(400);
  });
});
