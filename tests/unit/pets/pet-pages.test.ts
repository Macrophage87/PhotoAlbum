import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { listPeople, personMedia } from "@/lib/people/queries";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { updatePet } from "@/app/people/actions";

describe("a pet the animal matcher found", () => {
  let me: string, tagged: string, matched: string, biscuit: string;

  const photo = async (name: string) =>
    (await db.photo.create({ data: { uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY" } })).id;

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    who.id = me;
    tagged = await photo("tagged.jpg");
    matched = await photo("matched.jpg");
    biscuit = (await db.person.create({ data: { name: "Buddy", kind: "PET", species: "DOG", createdById: me } })).id;
    // One photograph by a member's tag, the other by the matcher's guess that somebody agreed with.
    await db.face.create({ data: { photoId: tagged, personId: biscuit, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.animalDetection.create({ data: { photoId: matched, personId: biscuit, species: "DOG", status: "CONFIRMED", box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.9 } });
  });

  it("is on its page and in its count as surely as a tagged one", async () => {
    const viewer: Viewer = { kind: "user", user: { id: me, email: "x@example.com", name: null, role: "ADMIN" }, shareTokens: new Map() };
    const media = await personMedia(viewer, biscuit);
    expect(media.map((m) => m.id).sort()).toEqual([tagged, matched].sort());
    const card = (await listPeople()).find((p) => p.id === biscuit)!;
    expect(card.photoCount).toBe(2);
  });

  it("is found under its new name after a rename, on every photograph", async () => {
    const fd = new FormData();
    fd.set("name", "Biscuit");
    fd.set("species", "DOG");
    await updatePet(biscuit, fd);
    const found = async (word: string) => (await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Photo" WHERE "searchVectorMembers" @@ plainto_tsquery('simple', ${word})`).map((r) => r.id).sort();
    expect(await found("Biscuit")).toEqual([tagged, matched].sort());
    expect(await found("Buddy")).toEqual([]);
  });
});
