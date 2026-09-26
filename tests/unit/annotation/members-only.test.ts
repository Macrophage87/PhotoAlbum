import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema } from "@/lib/annotation/schema";
import { descriptionFromMembersOnly, writtenFromMembersOnly } from "@/lib/annotation/members-only";
import { resetTestDb } from "../helpers/reset";

const record = (over: Record<string, unknown> = {}) =>
  annotationSchema.parse({ title: "Mail boat lunch", caption: "Lobster rolls on the mail boat", description: "Lunch on the deck of the mail boat.", tags: ["boat", "lunch"], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "boat, lunch, lobster", estimatedYear: null, estimatedPlace: null, ...over });

/** When the helper's words are the family's alone: written from a name, from the notes, or naming somebody known. */
describe("deciding the helper's text is for members only", () => {
  let userId: string, photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "dana@example.com", name: "Dana" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", lat: 1, lng: 1 } })).id;
  });

  it("leaves text written from nothing private public, and gives it the title", async () => {
    await applyAnnotation(photoId, "m", record(), {});
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect([p.annotationMembersOnly, p.title, p.membersTitle]).toEqual([false, "Mail boat lunch", null]);
  });

  it("keeps it for members when anybody is tagged on the item, whether or not the helper used the name", async () => {
    const pet = await db.person.create({ data: { name: "Biscuit", kind: "PET", createdById: userId } });
    await db.animalDetection.create({ data: { photoId, personId: pet.id, status: "CONFIRMED", box: {}, confidence: 0.9, species: "DOG" } });
    await applyAnnotation(photoId, "m", record(), {});
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect([p.annotationMembersOnly, p.title, p.membersTitle]).toEqual([true, null, "Mail boat lunch"]);
  });

  it("keeps it for members when it names somebody the album knows, a member included", async () => {
    await applyAnnotation(photoId, "m", record({ caption: "Dana's lobster roll" }), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotationMembersOnly).toBe(true);
    expect(await writtenFromMembersOnly(photoId, record({ tags: ["dana"] }), null)).toBe(true);
    expect(await writtenFromMembersOnly(photoId, record(), "  ")).toBe(false);
    expect(await writtenFromMembersOnly(photoId, record(), "Nana's boat")).toBe(true);
  });

  it("never moves a title the family wrote themselves", async () => {
    await db.photo.update({ where: { id: photoId }, data: { title: "Our boat day", context: "with Nana" } });
    await applyAnnotation(photoId, "m", record(), {});
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect([p.annotationMembersOnly, p.title, p.membersTitle]).toEqual([true, "Our boat day", "Mail boat lunch"]);
  });

  it("judges a trip's or an activity's description the same way", async () => {
    expect(await descriptionFromMembersOnly("A week on the water.", { names: [], notes: false })).toBe(false);
    expect(await descriptionFromMembersOnly("A week on the water.", { names: ["Ada"], notes: false })).toBe(true);
    expect(await descriptionFromMembersOnly("A week on the water.", { names: [], notes: true })).toBe(true);
    expect(await descriptionFromMembersOnly("A week on the water with Dana.", { names: [], notes: false })).toBe(true);
  });
});
