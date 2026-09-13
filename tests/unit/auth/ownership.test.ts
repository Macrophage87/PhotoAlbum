import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { canEditContainer, canEditMedia, editableMediaIds } from "@/lib/auth/ownership";
import { resetTestDb } from "../helpers/reset";

const kate = { id: "kate", role: "MEMBER" as const };
const sam = { id: "sam", role: "MEMBER" as const };
const admin = { id: "jo", role: "ADMIN" as const };

describe("who may change a thing", () => {
  it("lets the member who uploaded an item change it, and nobody else in the family", () => {
    const photo = { uploaderId: "kate" };
    expect(canEditMedia(kate, photo)).toBe(true);
    expect(canEditMedia(sam, photo)).toBe(false);
    expect(canEditMedia(admin, photo)).toBe(true);
    // A visitor with no account is not a member at all.
    expect(canEditMedia(null, photo)).toBe(false);
  });

  it("lets whoever made a trip or collection arrange it, and admins", () => {
    const trip = { createdById: "kate" };
    expect(canEditContainer(kate, trip)).toBe(true);
    expect(canEditContainer(sam, trip)).toBe(false);
    expect(canEditContainer(admin, trip)).toBe(true);
    // A container whose maker is gone is an admin's to look after.
    expect(canEditContainer(kate, { createdById: null })).toBe(false);
    expect(canEditContainer(admin, { createdById: null })).toBe(true);
  });
});

describe("a selection reaching across the family's photos", () => {
  let mine: string, yours: string;

  beforeEach(async () => {
    await resetTestDb();
    const me = await db.user.create({ data: { email: "kate@example.com" } });
    const you = await db.user.create({ data: { email: "sam@example.com" } });
    const photo = (uploaderId: string, name: string) =>
      db.photo.create({ data: { uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    mine = (await photo(me.id, "mine.jpg")).id;
    yours = (await photo(you.id, "yours.jpg")).id;
    Object.assign(kate, { id: me.id });
    Object.assign(sam, { id: you.id });
  });

  it("narrows a bulk change to the part of the selection that is this member's", async () => {
    expect(await editableMediaIds(kate, [mine, yours])).toEqual([mine]);
    expect(await editableMediaIds(sam, [mine, yours])).toEqual([yours]);
  });

  it("hands an admin the whole selection without asking the database", async () => {
    expect(await editableMediaIds({ id: "someone", role: "ADMIN" }, [mine, yours])).toEqual([mine, yours]);
  });
});
