import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: "X", role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { placePhotos, restorePlaces } from "@/app/photos/bulk-actions";

/** Undoing a move on the placing screen puts back everything the move changed, from the server's note of it (#97). */
describe("undoing a place", () => {
  let alice: string, bob: string, admin: string;
  const photo = (data: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: alice, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
  const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id } });
  const as = (id: string, role: "MEMBER" | "ADMIN") => { who.id = id; who.role = role; };
  beforeEach(async () => {
    await resetTestDb();
    alice = (await db.user.create({ data: { email: "alice@example.com", name: "Alice" } })).id;
    bob = (await db.user.create({ data: { email: "bob@example.com", name: "Bob" } })).id;
    admin = (await db.user.create({ data: { email: "admin@example.com", name: "Admin", role: "ADMIN" } })).id;
    as(admin, "ADMIN");
  });

  it("brings back the altitude the camera recorded", async () => {
    const p = await photo({ lat: 46.5, lng: 8.0, altitude: 1200, gpsSource: "EXIF" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    expect((await row(p.id)).altitude).toBeNull();
    await restorePlaces(before, undo);
    expect(await row(p.id)).toMatchObject({ lat: 46.5, lng: 8.0, altitude: 1200, gpsSource: "EXIF", placeSetById: null });
  });

  it("names whoever had placed it by hand, not whoever made the mistaken move", async () => {
    const p = await photo({ lat: 39.3, lng: -76.6, gpsSource: "MANUAL", placeSetById: alice, placeName: "Fells Point" });
    const { before, undo } = await placePhotos([p.id], 10, 20, "Somewhere else");
    expect((await row(p.id)).placeSetById).toBe(admin);
    await restorePlaces(before, undo);
    expect(await row(p.id)).toMatchObject({ lat: 39.3, gpsSource: "MANUAL", placeSetById: alice, placeName: "Fells Point" });
  });

  it("believes nothing the browser says about a place, only which ones to take back", async () => {
    as(alice, "MEMBER");
    const p = await photo({ lat: 39.3, lng: -76.6, gpsSource: "MANUAL", placeSetById: alice });
    const { undo } = await placePhotos([p.id], 10, 20);
    // Naming another member, claiming the camera's GPS, and making up a height and a spot are all ignored.
    await restorePlaces([{ id: p.id, lat: 1, lng: 2, gpsSource: "EXIF", placeName: "Paris", removedByHand: false, placeSetById: bob, altitude: 8848 } as never], undo);
    expect(await row(p.id)).toMatchObject({ lat: 39.3, lng: -76.6, altitude: null, gpsSource: "MANUAL", placeName: null, placeSetById: alice });
  });

  it("without the server's note, puts the spot back as the presser's own placing", async () => {
    as(alice, "MEMBER");
    const p = await photo({ lat: 1, lng: 2, altitude: 50, gpsSource: "EXIF" });
    await placePhotos([p.id], 10, 20);
    await restorePlaces([{ id: p.id, lat: 1, lng: 2, gpsSource: "EXIF", placeName: null, removedByHand: false, placeSetById: bob, altitude: 8848 } as never], "no-such-token");
    expect(await row(p.id)).toMatchObject({ lat: 1, lng: 2, altitude: null, gpsSource: "MANUAL", placeSetById: alice });
  });

  it("takes nothing from another member's note", async () => {
    const p = await photo({ lat: 5, lng: 6, altitude: 10, gpsSource: "EXIF" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    as(alice, "MEMBER");
    await restorePlaces(before, undo);
    expect(await row(p.id)).toMatchObject({ lat: 5, gpsSource: "MANUAL", altitude: null, placeSetById: alice });
  });

  it("says what it wrote, and uses a note only once", async () => {
    as(alice, "MEMBER");
    const p = await photo({ lat: 5, lng: 6, altitude: 10, gpsSource: "EXIF" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    expect(await restorePlaces(before, undo)).toEqual([{ id: p.id, lat: 5, lng: 6, gpsSource: "EXIF" }]);
    // Pressed again (a stale tab, a double tap), the note is gone: the spot comes back as the presser's own placing.
    await placePhotos([p.id], 10, 20);
    expect(await restorePlaces(before, undo)).toEqual([{ id: p.id, lat: 5, lng: 6, gpsSource: "MANUAL" }]);
    expect(await row(p.id)).toMatchObject({ altitude: null, placeSetById: alice });
  });

  it("restores nobody as the placer when nobody had placed it", async () => {
    const p = await photo({ lat: 5, lng: 6, gpsSource: "TRACK" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    await restorePlaces(before, undo);
    expect(await row(p.id)).toMatchObject({ lat: 5, gpsSource: "TRACK", placeSetById: null });
  });
});
