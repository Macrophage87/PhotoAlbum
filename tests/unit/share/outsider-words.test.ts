import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { PhotoCard } from "@/lib/photos/queries";
import { getSharedCollection, getSharedTrip } from "@/lib/share/queries";
import { resetTestDb } from "../helpers/reset";

describe("alt text for an item with no caption or title", () => {
  const card = (extra: Partial<PhotoCard> = {}) => ({ id: "p1", uploaderId: "u", kind: "PHOTO", status: "READY", updatedAt: new Date(), edits: null, renditions: null, caption: null, title: null, membersTitle: null, originalName: "Mum at Hopkins oncology.jpg", takenAt: new Date("2025-08-12T23:30:00Z"), tzOffsetMin: -240, uploader: null, collections: [], ...extra }) as unknown as PhotoCard;

  it("never reads a stranger the file's own name: what it is and the day, on its own clock", () => {
    const alt = toGridPhoto(card()).alt;
    expect(alt).toBe("Photo taken August 12, 2025");
    expect(alt).not.toContain("Hopkins");
    expect(toGridPhoto(card({ kind: "VIDEO", takenAt: null })).alt).toBe("Video");
    expect(toGridPhoto(card({ kind: "SCAN", takenAt: null })).alt).toBe("3D scan");
  });

  it("reads a member the file's name, and anybody a caption", () => {
    expect(toGridPhoto(card(), null, { id: "m", role: "MEMBER" }).alt).toBe("Mum at Hopkins oncology.jpg");
    expect(toGridPhoto(card({ caption: "On the porch" })).alt).toBe("On the porch");
  });
});

describe("a share link's counts", () => {
  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "jo@example.com" } });
    const trip = await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id, visibility: "LINK", shareToken: "ttok" } });
    const col = await db.collection.create({ data: { slug: "best", title: "Best", createdById: u.id, visibility: "LINK", shareToken: "ctok" } });
    for (const [name, trashedAt] of [["kept.jpg", null], ["binned.jpg", new Date()]] as const) {
      const p = await db.photo.create({ data: { tripId: trip.id, uploaderId: u.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", trashedAt, trashReason: trashedAt ? "OTHER" : null } });
      await db.collectionItem.create({ data: { collectionId: col.id, photoId: p.id, addedById: u.id } });
    }
  });

  it("leaves out what is in the trash, which the link no longer reaches", async () => {
    expect((await getSharedTrip("ttok"))?._count.photos).toBe(1);
    expect((await getSharedCollection("ctok"))?._count.items).toBe(1);
  });
});
