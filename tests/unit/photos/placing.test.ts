import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { photosForPlacing } from "@/lib/photos/placing";
import { parseGalleryFilter } from "@/lib/photos/filters";
import type { ViewerUser } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

/**
 * The place screen lists a member's own photographs and pictures only; the search above it narrows that list and
 * must not be able to replace it with somebody else's, or with things that have no picture to place.
 */
describe("the photographs offered for placing", () => {
  let bob: ViewerUser, alice: ViewerUser, trip: { id: string; timezone: string };

  beforeAll(async () => {
    await resetTestDb();
    const a = await db.user.create({ data: { email: "alice@example.com", name: "Alice", role: "MEMBER" } });
    const b = await db.user.create({ data: { email: "bob@example.com", name: "Bob", role: "MEMBER" } });
    alice = { id: a.id, email: a.email, name: a.name, role: "MEMBER" };
    bob = { id: b.id, email: b.email, name: b.name, role: "MEMBER" };
    trip = { id: (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: a.id } })).id, timezone: "UTC" };
    const photo = (uploaderId: string, originalName: string, kind: "PHOTO" | "SCAN" = "PHOTO") => db.photo.create({ data: { originalName, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", uploaderId, tripId: trip.id, kind } });
    await photo(alice.id, "alice.jpg");
    await photo(alice.id, "alice-scan.glb", "SCAN");
    await photo(bob.id, "bob.jpg");
    await photo(bob.id, "bob-scan.glb", "SCAN");
  });

  it("keeps a member to their own however the address names somebody else", async () => {
    const asked = parseGalleryFilter({ uploader: alice.id }, { member: true });
    const { photos, total } = await photosForPlacing(bob, trip, asked, "all");
    expect(photos.map((p) => p.label)).toEqual([]);
    expect(total).toBe(0);
    expect((await photosForPlacing(bob, trip, parseGalleryFilter({}, { member: true }), "all")).photos.map((p) => p.label)).toEqual(["bob.jpg"]);
  });

  it("never offers a scan, even when the address asks for scans", async () => {
    const { photos } = await photosForPlacing(bob, trip, parseGalleryFilter({ kind: "SCAN" }, { member: true }), "all");
    expect(photos).toEqual([]);
  });

  it("lets an admin narrow to one member's photographs", async () => {
    const admin: ViewerUser = { ...alice, role: "ADMIN" };
    const { photos } = await photosForPlacing(admin, trip, parseGalleryFilter({ uploader: bob.id }, { member: true }), "all");
    expect(photos.map((p) => p.label)).toEqual(["bob.jpg"]);
  });
});
