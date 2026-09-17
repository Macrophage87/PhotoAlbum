import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { tripPhotoPage } from "@/lib/photos/page";
import { tripTimeline } from "@/lib/timeline/queries";
import { buildMapPayload } from "@/lib/map/geojson";
import { listTripPhotos } from "@/lib/photos/queries";
import { getTripBySlug } from "@/lib/trips/queries";
import { searchMedia } from "@/lib/search/query";
import { canViewMedia, isPubliclyViewable, visibleMediaWhere } from "@/lib/auth/access";
import { backfillCandidates } from "@/lib/jobs/handlers/annotation-batch";
import { TRASH_REASONS, trashReasonLabel, trashSchema } from "@/lib/photos/trash";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const member: Viewer = { kind: "user", user: { id: "u", email: "m@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };
const stranger: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

describe("the reason a member gives", () => {
  it("offers the common ones and always accepts a note", () => {
    expect(TRASH_REASONS.map((r) => r.value)).toContain("DUPLICATE");
    expect(trashSchema.parse({ reason: "BLURRY", note: "" })).toEqual({ reason: "BLURRY", note: "" });
    expect(trashSchema.safeParse({ reason: "NOT_A_REASON", note: "" }).success).toBe(false);
  });
  it("reads back as a sentence, with the note after the reason", () => {
    expect(trashReasonLabel("DUPLICATE", null)).toBe("A duplicate of another item");
    expect(trashReasonLabel("OTHER", "wrong dog")).toBe("Something else — wrong dog");
    expect(trashReasonLabel(null, null)).toBe("No reason given");
  });
});

describe("an item in the trash", () => {
  let tripId: string, trashedId: string, keptId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "t@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PUBLIC" } });
    tripId = trip.id;
    const base = { tripId, uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, takenAtSource: "EXIF_OFFSET" as const, tzOffsetMin: 0, lat: 44.35, lng: -68.2, gpsSource: "EXIF" as const };
    keptId = (await db.photo.create({ data: { ...base, originalName: "kept.jpg", caption: "lobster rolls on the boat", takenAt: new Date("2025-08-11T12:00:00Z") } })).id;
    trashedId = (await db.photo.create({ data: { ...base, originalName: "gone.jpg", caption: "lobster rolls on the boat", takenAt: new Date("2025-08-11T12:01:00Z") } })).id;
    await db.$executeRaw`UPDATE "Photo" SET "searchVector" = to_tsvector('english', caption), "searchVectorMembers" = to_tsvector('english', caption)`;
    await db.photo.update({ where: { id: trashedId }, data: { trashedAt: new Date(), trashedById: user.id, trashReason: "BLURRY" } });
  });

  it("leaves the gallery, the timeline and the map", async () => {
    expect((await tripPhotoPage(tripId)).photos.map((p) => p.id)).toEqual([keptId]);
    expect((await tripPhotoPage(tripId)).total).toBe(1);
    expect((await listTripPhotos(tripId)).map((p) => p.id)).toEqual([keptId]);
    const { groups: days } = await tripTimeline(tripId, "UTC");
    expect(days.flatMap((g) => g.items.flatMap((i) => i.photos ?? [])).map((p) => p.id)).toEqual([keptId]);
    const map = await buildMapPayload(member, tripId);
    expect(map.photos.features.map((f) => f.properties.id)).toEqual([keptId]);
  });

  it("stops being counted on the trip card", async () => {
    expect((await getTripBySlug("t"))!._count.photos).toBe(1);
  });

  it("is not findable by search, by a member or by a visitor", async () => {
    const asMember = await searchMedia(member, { q: "lobster" }, 50, null);
    expect(asMember.map((h) => h.id)).toEqual([keptId]);
    const asStranger = await searchMedia(stranger, { q: "lobster" }, 50, null);
    expect(asStranger.map((h) => h.id)).toEqual([keptId]);
  });

  it("is out of reach of a share link or a public trip, but a member can still open it", () => {
    const media = { trashedAt: new Date(), trip: { id: "t", visibility: "PUBLIC" as const, shareToken: null }, collections: [] };
    expect(canViewMedia(stranger, media)).toBe(false);
    expect(canViewMedia(member, media)).toBe(true);
    expect(isPubliclyViewable(media)).toBe(false);
  });

  it("is left out of the filter every surface shares, for members too", () => {
    expect(visibleMediaWhere(member)).toMatchObject({ trashedAt: null });
    expect(visibleMediaWhere(stranger)).toMatchObject({ trashedAt: null });
  });

  it("is never sent to the AI helper by a backfill", async () => {
    const ids = (await backfillCandidates({ kind: "all" })).map((p) => p.id);
    expect(ids).toEqual([keptId]);
    const places = (await backfillCandidates({ kind: "all", task: "place" })).map((p) => p.id);
    expect(places).not.toContain(trashedId);
  });

  it("comes back exactly as it was when an admin restores it", async () => {
    await db.photo.update({ where: { id: trashedId }, data: { trashedAt: null, trashedById: null, trashReason: null, trashNote: null } });
    expect((await tripPhotoPage(tripId)).photos.map((p) => p.id).sort()).toEqual([keptId, trashedId].sort());
  });
});
