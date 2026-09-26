import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: "X", role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { placePhotos, restorePlaces } from "@/app/photos/bulk-actions";

/** Undoing a move on the placing screen puts back everything the move changed (#97). */
describe("undoing a place", () => {
  let alice: string, admin: string;
  const photo = (data: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: alice, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
  beforeEach(async () => {
    await resetTestDb();
    alice = (await db.user.create({ data: { email: "alice@example.com", name: "Alice" } })).id;
    admin = (await db.user.create({ data: { email: "admin@example.com", name: "Admin", role: "ADMIN" } })).id;
    who.id = admin;
    who.role = "ADMIN";
  });

  it("brings back the altitude the camera recorded", async () => {
    const p = await photo({ lat: 46.5, lng: 8.0, altitude: 1200, gpsSource: "EXIF" });
    const { before } = await placePhotos([p.id], 10, 20);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).altitude).toBeNull();
    await restorePlaces(before);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ lat: 46.5, lng: 8.0, altitude: 1200, gpsSource: "EXIF", placeSetById: null });
  });

  it("names whoever had placed it by hand, not whoever made the mistaken move", async () => {
    const p = await photo({ lat: 39.3, lng: -76.6, gpsSource: "MANUAL", placeSetById: alice, placeName: "Fells Point" });
    const { before } = await placePhotos([p.id], 10, 20, "Somewhere else");
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).placeSetById).toBe(admin);
    await restorePlaces(before);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ lat: 39.3, gpsSource: "MANUAL", placeSetById: alice, placeName: "Fells Point" });
  });

  it("still takes an Undo from a page loaded before altitude was kept", async () => {
    const p = await photo({ lat: 1, lng: 2, gpsSource: "EXIF" });
    await placePhotos([p.id], 10, 20);
    await restorePlaces([{ id: p.id, lat: 1, lng: 2, gpsSource: "EXIF", placeName: null } as never]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ lat: 1, altitude: null, gpsSource: "EXIF" });
  });
});
