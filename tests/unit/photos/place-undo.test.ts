import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: "X", role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { placePhotos, restorePlaces } from "@/app/photos/bulk-actions";
import { clearPhotoPlace, setPhotoPlace } from "@/app/photos/[id]/actions";

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
    // Not Alice's move to take back: the admin placed it, so it is left where the admin put it.
    expect(await restorePlaces(before, undo)).toEqual({ restored: [], changed: 1 });
    expect(await row(p.id)).toMatchObject({ lat: 10, lng: 20, gpsSource: "MANUAL", altitude: null, placeSetById: admin });
  });

  it("says what it wrote, and uses a note only once", async () => {
    as(alice, "MEMBER");
    const p = await photo({ lat: 5, lng: 6, altitude: 10, gpsSource: "EXIF" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    expect(await restorePlaces(before, undo)).toEqual({ restored: [{ id: p.id, lat: 5, lng: 6, gpsSource: "EXIF" }], changed: 0 });
    // Pressed again (a stale tab, a double tap), the note is gone: the spot comes back as the presser's own placing.
    await placePhotos([p.id], 10, 20);
    expect(await restorePlaces(before, undo)).toEqual({ restored: [{ id: p.id, lat: 5, lng: 6, gpsSource: "MANUAL" }], changed: 0 });
    expect(await row(p.id)).toMatchObject({ altitude: null, placeSetById: alice });
  });

  it("restores nobody as the placer when nobody had placed it", async () => {
    const p = await photo({ lat: 5, lng: 6, gpsSource: "TRACK" });
    const { before, undo } = await placePhotos([p.id], 10, 20);
    await restorePlaces(before, undo);
    expect(await row(p.id)).toMatchObject({ lat: 5, gpsSource: "TRACK", placeSetById: null });
  });

  describe("after the photograph has changed since the move", () => {
    const placeAt = (id: string, lat: number, lng: number) => {
      const fd = new FormData();
      fd.set("lat", String(lat));
      fd.set("lng", String(lng));
      return setPhotoPlace(id, fd);
    };
    const guessed = () => photo({ lat: 39.29, lng: -76.61, gpsSource: "ESTIMATE", placeEstimateName: "Inner Harbor, Baltimore", placeEstimateNote: "the Domino Sugar sign", placeEstimateConfidence: 0.8 });

    it("leaves a place an admin cleared by hand cleared, and says it left it", async () => {
      const p = await guessed();
      as(alice, "MEMBER");
      const { before, undo } = await placePhotos([p.id], 10, 20);
      as(admin, "ADMIN");
      await clearPhotoPlace(p.id);
      as(alice, "MEMBER");
      expect(await restorePlaces(before, undo, { lat: 10, lng: 20 })).toEqual({ restored: [], changed: 1 });
      // The guess does not come back over the admin's decision.
      expect(await row(p.id)).toMatchObject({ lat: null, lng: null, gpsSource: null, placeSetById: admin, placeEstimateName: null });
    });

    it("leaves a place set somewhere else since, even by the same member, and takes back the rest", async () => {
      as(alice, "MEMBER");
      const moved = await photo({ lat: 5, lng: 6, gpsSource: "EXIF" });
      const kept = await photo({ lat: 7, lng: 8, gpsSource: "EXIF" });
      const { before, undo } = await placePhotos([moved.id, kept.id], 10, 20);
      await placeAt(moved.id, 30, 40);
      expect(await restorePlaces(before, undo, { lat: 10, lng: 20 })).toEqual({ restored: [{ id: kept.id, lat: 7, lng: 8, gpsSource: "EXIF" }], changed: 1 });
      expect(await row(moved.id)).toMatchObject({ lat: 30, lng: 40, gpsSource: "MANUAL", placeSetById: alice });
      expect(await row(kept.id)).toMatchObject({ lat: 7, lng: 8, gpsSource: "EXIF" });
    });

    it("without the server's note, still takes back only what is on the pin the screen placed it on", async () => {
      as(alice, "MEMBER");
      const p = await photo({ lat: 5, lng: 6, gpsSource: "EXIF" });
      const { before } = await placePhotos([p.id], 10, 20);
      await placeAt(p.id, 30, 40);
      expect(await restorePlaces(before, "no-such-token", { lat: 10, lng: 20 })).toEqual({ restored: [], changed: 1 });
      expect(await row(p.id)).toMatchObject({ lat: 30, lng: 40 });
    });

    it("brings a guess back for members only when the notes written since would give it away", async () => {
      const p = await guessed();
      as(alice, "MEMBER");
      const { before, undo } = await placePhotos([p.id], 10, 20);
      // Written while the guess was covered by the move: the guess may now be read as coming from them.
      await db.photo.update({ where: { id: p.id }, data: { context: "Aunt May's flat is just over the water" } });
      await restorePlaces(before, undo);
      expect(await row(p.id)).toMatchObject({ gpsSource: "ESTIMATE", placeEstimateName: "Inner Harbor, Baltimore", placeEstimateMembersOnly: true });
    });

    it("brings a guess back as it was when nothing about it has changed", async () => {
      const p = await guessed();
      as(alice, "MEMBER");
      const { before, undo } = await placePhotos([p.id], 10, 20);
      await restorePlaces(before, undo);
      expect(await row(p.id)).toMatchObject({ gpsSource: "ESTIMATE", placeEstimateMembersOnly: false });
    });
  });
});
