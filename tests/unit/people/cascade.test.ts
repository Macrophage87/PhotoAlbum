import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { permittedNames } from "@/lib/people/gates";
import { resetTestDb } from "../helpers/reset";

describe("names that may reach the helper", () => {
  let photoId: string, userId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "c@example.com", role: "ADMIN" } });
    userId = user.id;
    photoId = (await db.photo.create({ data: { uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  });
  async function face(personId: string, status: "CONFIRMED" | "PROPOSED" = "CONFIRMED") {
    await db.face.create({ data: { photoId, personId, status, box: [0, 0, 1, 1], confidence: 0.9 } });
  }
  it("includes indexed adults and pets, never minors, unindexed or merely proposed people", async () => {
    const jo = await db.person.create({ data: { name: "Grandma Jo", birthday: new Date("1946-01-01"), faceIndexing: true, createdById: userId } });
    const sam = await db.person.create({ data: { name: "Sam", birthday: new Date("2019-05-01"), faceIndexing: true, createdById: userId } });
    const kate = await db.person.create({ data: { name: "Kate", birthday: new Date("1985-01-01"), faceIndexing: false, createdById: userId } });
    const dan = await db.person.create({ data: { name: "Dan", birthday: new Date("1985-01-01"), faceIndexing: true, createdById: userId } });
    const biscuit = await db.person.create({ data: { name: "Biscuit", kind: "PET", species: "DOG", createdById: userId } });
    await face(jo.id);
    await face(sam.id);
    await face(kate.id);
    await face(dan.id, "PROPOSED");
    await face(biscuit.id);
    expect((await permittedNames(photoId)).sort()).toEqual(["Biscuit", "Grandma Jo"]);
  });
  it("puts confirmed names in the members search column only", async () => {
    const jo = await db.person.create({ data: { name: "Josephine", birthday: new Date("1946-01-01"), faceIndexing: true, createdById: userId } });
    await face(jo.id);
    const members = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Photo" WHERE "searchVectorMembers" @@ websearch_to_tsquery('simple', 'Josephine')`;
    const anon = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Photo" WHERE "searchVector" @@ websearch_to_tsquery('english', 'Josephine')`;
    expect(members.map((r) => r.id)).toEqual([photoId]);
    expect(anon).toEqual([]);
  });
});
