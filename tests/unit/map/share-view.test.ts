import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET as tripGeojson } from "@/app/api/trips/[slug]/geojson/route";
import { GET as collectionGeojson } from "@/app/api/collections/[slug]/geojson/route";
import { GET as activityGeojson } from "@/app/api/activities/[id]/geojson/route";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

type Feature = { properties: { id: string; uploaderName: string | null; uploaderId: string | null } };
const people = async (res: Response) => ((await res.json()).photos.features as Feature[]).map((f) => [f.properties.uploaderId !== null, f.properties.uploaderName]);

/** A shared link's map shows what anybody holding the link sees: a member reading it is not shown who uploaded what. */
describe("a shared link's map, read by a member", () => {
  let member: Viewer, activityId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "g@example.com", name: "Gwen", role: "ADMIN" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "ADMIN" }, shareTokens: new Map() };
    who.viewer = member;
    const trip = await db.trip.create({ data: { slug: "linked", title: "Linked", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "LINK", shareToken: "tok" } });
    activityId = (await db.activity.create({ data: { tripId: trip.id, title: "Walk", type: "HIKE", startTime: new Date("2025-08-11T10:00:00Z"), endTime: new Date("2025-08-11T12:00:00Z") } })).id;
    const photo = await db.photo.create({ data: { tripId: trip.id, activityId, uploaderId: user.id, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", lat: 44, lng: -68, gpsSource: "EXIF", takenAt: new Date("2025-08-11T11:00:00Z") } });
    const collection = await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "LINK", shareToken: "ctok" } });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: photo.id, addedById: user.id } });
  });

  it("leaves out who uploaded each photograph with view=share, and keeps it on the member's own map", async () => {
    const trip = (view: string) => tripGeojson(new Request(`http://album.test/api/trips/linked/geojson${view}`), { params: Promise.resolve({ slug: "linked" }) });
    expect(await people(await trip(""))).toEqual([[true, "Gwen"]]);
    expect(await people(await trip("?view=share"))).toEqual([[false, null]]);
    const collection = (view: string) => collectionGeojson(new Request(`http://album.test/api/collections/c/geojson${view}`), { params: Promise.resolve({ slug: "c" }) });
    expect(await people(await collection(""))).toEqual([[true, "Gwen"]]);
    expect(await people(await collection("?view=share"))).toEqual([[false, null]]);
    const activity = (view: string) => activityGeojson(new Request(`http://album.test/api/activities/${activityId}/geojson${view}`), { params: Promise.resolve({ id: activityId }) } as never);
    expect(await people(await activity(""))).toEqual([[true, "Gwen"]]);
    expect(await people(await activity("?view=share"))).toEqual([[false, null]]);
  });

  it("still opens for the member, who may open the trip whether or not they came by the link", async () => {
    const res = await tripGeojson(new Request("http://album.test/api/trips/linked/geojson?view=share"), { params: Promise.resolve({ slug: "linked" }) });
    expect(res.status).toBe(200);
    // And a visitor without the link is still turned away, view=share or not.
    who.viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
    expect((await tripGeojson(new Request("http://album.test/api/trips/linked/geojson?view=share"), { params: Promise.resolve({ slug: "linked" }) })).status).toBe(404);
  });
});
