import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET } from "@/app/api/photos/[id]/info/route";
import type { PhotoInfo } from "@/app/api/photos/[id]/info/route";
import { generateMetadata } from "@/app/share/a/[token]/page";
import { getSharedActivity } from "@/lib/share/queries";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

async function info(id: string, query = ""): Promise<{ status: number; body: PhotoInfo }> {
  const res = await GET(new Request(`http://localhost/api/photos/${id}/info${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as PhotoInfo };
}

/**
 * The lightbox beside a photograph from a private trip, shown to a stranger through a public collection: the
 * picture, and nothing of the trip or of the family's words about it.
 */
describe("the lightbox's words for a stranger", () => {
  let member: Viewer, photoId: string, trashedId: string, linkTripToken: string;

  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    const trip = await db.trip.create({ data: { slug: "hopkins", title: "Hopkins weekend", timezone: "America/New_York", themeKey: "coast", startDate: new Date("2025-03-01"), endDate: new Date("2025-03-03"), createdById: user.id } });
    const photo = await db.photo.create({
      data: {
        uploaderId: user.id, tripId: trip.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY",
        context: "Mum's second round", membersTitle: "Mum in the waiting room", annotation: { title: "Mum in the waiting room", description: "Mum reads in the waiting room." }, annotationMembersOnly: true,
        lat: 39.3, lng: -76.6, gpsSource: "ESTIMATE", placeEstimateName: "Baltimore, Maryland", placeEstimateNote: "the notes say Hopkins", placeEstimateConfidence: 0.8, placeEstimatePrecision: "CITY", placeEstimateMembersOnly: true,
      },
    });
    photoId = photo.id;
    const col = await db.collection.create({ data: { slug: "views", title: "Views", visibility: "PUBLIC", createdById: user.id } });
    await db.collectionItem.create({ data: { collectionId: col.id, photoId, addedById: user.id } });
    // A photograph on a shared trip that has since gone in the trash.
    linkTripToken = "linktok";
    const linkTrip = await db.trip.create({ data: { slug: "linked", title: "Linked", visibility: "LINK", shareToken: linkTripToken, startDate: new Date("2025-03-01"), endDate: new Date("2025-03-03"), createdById: user.id } });
    trashedId = (await db.photo.create({ data: { uploaderId: user.id, tripId: linkTrip.id, originalName: "y.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", caption: "In the bin", trashedAt: new Date(), trashReason: "OTHER" } })).id;
  });

  it("shows a stranger the picture's place but not the trip, the helper's words, the title or the guess's reasons", async () => {
    who.viewer = anon;
    const { status, body } = await info(photoId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ trip: null, title: null, description: null, timezone: null, themeKey: null, uploadedBy: null });
    expect(body.placeEstimate).toMatchObject({ name: null, note: null, confidence: 0.8 });
    expect([body.lat, body.lng]).toEqual([39.3, -76.6]);
    expect(JSON.stringify(body)).not.toMatch(/Mum|Hopkins|waiting/);
  });

  it("shows a member all of it", async () => {
    who.viewer = member;
    const { body } = await info(photoId);
    expect(body).toMatchObject({ trip: { slug: "hopkins", title: "Hopkins weekend" }, title: "Mum in the waiting room", description: "Mum reads in the waiting room.", timezone: "America/New_York", themeKey: "coast" });
    expect(body.placeEstimate).toMatchObject({ name: "Baltimore, Maryland", note: "the notes say Hopkins" });
  });

  it("refuses a trashed photograph on its trip's token in the address", async () => {
    who.viewer = anon;
    expect((await info(trashedId, `?share=${linkTripToken}&kind=trip`)).status).toBe(401);
  });

  it("does not name a private trip on an activity link's card", async () => {
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "hopkins" } });
    const activity = await db.activity.create({ data: { tripId: trip.id, title: "Walk to the car park", startTime: new Date("2025-03-01T15:00:00Z"), endTime: new Date("2025-03-01T16:00:00Z"), shareToken: "acttok" } });
    const card = await generateMetadata({ params: Promise.resolve({ token: "acttok" }) } as never);
    expect(JSON.stringify(card)).not.toContain("Hopkins");
    // Nor send its slug (made from its name) or title to the page: the map and header work without them.
    const shared = await getSharedActivity("acttok");
    expect(shared?.trip).toMatchObject({ slug: null, title: null });
    expect(card.openGraph?.description).toMatch(/March 1, 2025/);
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    expect((await generateMetadata({ params: Promise.resolve({ token: "acttok" }) } as never)).openGraph?.description).toContain("Hopkins weekend");
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PRIVATE" } });
    await db.activity.delete({ where: { id: activity.id } });
  });
});
