import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { faceCrop } from "@/lib/people/crop";
import { listUnnamedClusters, peopleOnPhoto } from "@/lib/people/queries";
import { vectorLiteral } from "@/lib/ml/client";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { markNotAFace, nameCluster, nameClusterAs, splitFaceFromCluster } from "@/app/people/actions";

describe("fitting a face into a small circle", () => {
  it("puts the face in the middle, with room for hair and chin", () => {
    // A quarter-sized face dead centre of a square photograph.
    const crop = faceCrop([0.375, 0.375, 0.25, 0.25], 1);
    // 0.25 × 1.35 = 0.3375 of the picture fills the circle, so the picture is drawn ~296% of it...
    expect(crop.widthPct).toBeCloseTo(296.3, 1);
    expect(crop.heightPct).toBeCloseTo(296.3, 1);
    // ...and shifted by the distance from its edge to the window, as a share of the circle, not of the picture.
    // That distinction is the whole bug: measured against the picture, this face landed outside the circle.
    expect(crop.leftPct).toBeCloseTo(-(0.33125 / 0.3375) * 100, 1);
    expect(crop.topPct).toBeCloseTo(-(0.33125 / 0.3375) * 100, 1);
  });

  it("keeps the window on the picture when the face is against an edge", () => {
    const crop = faceCrop([0, 0, 0.2, 0.2], 1);
    // Nothing to the left or above, so the picture sits flush and the circle is all photograph, never blank.
    expect(crop.leftPct).toBe(-0);
    expect(crop.topPct).toBe(-0);
    const corner = faceCrop([0.8, 0.8, 0.2, 0.2], 1);
    expect(corner.leftPct).toBeLessThan(0);
    expect(-corner.leftPct).toBeLessThanOrEqual(corner.widthPct - 100 + 0.001);
  });

  it("squares the crop in pixels, not in fractions, so a wide photograph does not stretch a face", () => {
    // On a 2:1 photograph the same fraction of the width is twice as many pixels as that fraction of the height.
    const wide = faceCrop([0.4, 0.3, 0.1, 0.2], 2);
    // The face is 0.1 × 2 = 0.2 wide and 0.2 tall in pixels: already square, so the window is 0.27 of the height
    // and half that, 0.135, of the width.
    expect(100 / wide.widthPct).toBeCloseTo(0.135, 3);
    expect(100 / wide.heightPct).toBeCloseTo(0.27, 3);
  });

  it("never asks for a window bigger than the picture", () => {
    const huge = faceCrop([0.05, 0.05, 0.9, 0.9], 1);
    expect(huge.widthPct).toBe(100);
    expect(huge.heightPct).toBe(100);
    expect(huge.leftPct).toBe(-0);
  });
});

describe("a group of faces that look alike", () => {
  let me: string, photoA: string, photoB: string, unfinished: string;
  let clusterId: string, faceA: string, faceB: string, faceUnfinished: string;

  const face = async (photoId: string, clusterId: string, box: number[], confidence: number) =>
    (await db.face.create({ data: { photoId, clusterId, box, confidence, status: "DETECTED" }, select: { id: true } })).id;

  beforeEach(async () => {
    await resetTestDb();
    who.role = "ADMIN";
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    const photo = (name: string, status: "READY" | "PROCESSING") =>
      db.photo.create({ data: { uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status, width: 1200, height: 800 } });
    photoA = (await photo("a.jpg", "READY")).id;
    photoB = (await photo("b.jpg", "READY")).id;
    unfinished = (await photo("c.jpg", "PROCESSING")).id;
    clusterId = (await db.faceCluster.create({ data: { faceCount: 3 } })).id;
    // Highest confidence first, and the unfinished photograph's face is the most confident of the three.
    faceUnfinished = await face(unfinished, clusterId, [0.1, 0.1, 0.2, 0.2], 0.99);
    faceA = await face(photoA, clusterId, [0.3, 0.2, 0.25, 0.35], 0.95);
    faceB = await face(photoB, clusterId, [0.5, 0.4, 0.2, 0.2], 0.9);
  });

  it("shows the faces themselves, and skips photographs that are not ready", async () => {
    const [group] = await listUnnamedClusters();
    // Every usable face, not a sample of four — you cannot disown a face you were never shown.
    expect(group.faces.map((f) => f.faceId).sort()).toEqual([faceA, faceB].sort());
    expect(group.faces.map((f) => f.faceId)).not.toContain(faceUnfinished);
    // And the photograph's shape comes with it, so the crop can square the face off properly.
    expect(group.faces[0]).toMatchObject({ width: 1200, height: 800 });
  });

  it("takes one face out of a group without touching the rest", async () => {
    await splitFaceFromCluster(faceA);
    const moved = await db.face.findUniqueOrThrow({ where: { id: faceA }, select: { clusterId: true, status: true } });
    expect(moved.clusterId).not.toBe(clusterId);
    expect(moved.clusterId).not.toBeNull();
    // It is still a face waiting for a name, just not in that group.
    expect(moved.status).toBe("DETECTED");
    expect(await db.face.count({ where: { clusterId } })).toBe(2);
    expect((await db.faceCluster.findUniqueOrThrow({ where: { id: clusterId } })).faceCount).toBe(2);
    // Naming the group it left no longer names it.
    const fd = new FormData();
    fd.set("name", "Grandma Jo");
    await nameCluster(clusterId, fd);
    expect((await db.face.findUniqueOrThrow({ where: { id: faceA } })).personId).toBeNull();
  });

  it("says a statue is not a face, keeps the spot, and drops the template", async () => {
    await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(Array(512).fill(0.1))}::vector WHERE id = ${faceA}`;
    await markNotAFace(faceA);
    const row = await db.face.findUniqueOrThrow({ where: { id: faceA }, select: { status: true, clusterId: true, confidence: true } });
    expect(row.status).toBe("NOT_A_FACE");
    expect(row.clusterId).toBeNull();
    // The row survives so a re-scan of the photograph recognises the spot; the confidence is what it matches on.
    expect(row.confidence).toBeGreaterThan(0);
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE id = ${faceA} AND embedding IS NOT NULL`)[0].n).toBe(0);
    // And it is nobody on that photograph any more.
    expect((await peopleOnPhoto(photoA)).map((f) => f.id)).not.toContain(faceA);
    const [group] = await listUnnamedClusters();
    expect(group.faces.map((f) => f.faceId)).not.toContain(faceA);
  });

  it("clears away a group whose last face has gone", async () => {
    await markNotAFace(faceA);
    await markNotAFace(faceB);
    await markNotAFace(faceUnfinished);
    expect(await db.faceCluster.findUnique({ where: { id: clusterId } })).toBeNull();
  });

  it("refuses to disown a face somebody has already named", async () => {
    const person = await db.person.create({ data: { name: "Jo", createdById: me } });
    await db.face.update({ where: { id: faceA }, data: { personId: person.id, status: "CONFIRMED" } });
    await expect(markNotAFace(faceA)).rejects.toThrow(/named/);
    await expect(splitFaceFromCluster(faceA)).rejects.toThrow(/named/);
  });
});

describe("joining a group to somebody already named", () => {
  let me: string, photoId: string, clusterId: string, faceId: string;

  beforeEach(async () => {
    await resetTestDb();
    who.role = "ADMIN";
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: me, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY", width: 1200, height: 800 } })).id;
    clusterId = (await db.faceCluster.create({ data: { faceCount: 1 } })).id;
    faceId = (await db.face.create({ data: { photoId, clusterId, box: [0.3, 0.2, 0.2, 0.2], confidence: 0.9, status: "DETECTED" }, select: { id: true } })).id;
  });

  it("needs no name typed in, which is what a second group of the same person is", async () => {
    const jo = await db.person.create({ data: { name: "Grandma Jo", faceIndexing: true, adultAttestedAt: new Date(), adultAttestedById: me, createdById: me } });
    // The form sends only the person when one is chosen. Requiring a name here threw instead of joining them.
    const fd = new FormData();
    fd.set("personId", jo.id);
    await nameCluster(clusterId, fd);
    expect((await db.face.findUniqueOrThrow({ where: { id: faceId } }))).toMatchObject({ personId: jo.id, status: "CONFIRMED" });
    expect((await db.faceCluster.findUniqueOrThrow({ where: { id: clusterId } })).personId).toBe(jo.id);
    // No second person was invented along the way.
    expect(await db.person.count()).toBe(1);
  });

  it("joins a group to a pet, and keeps no face template for it", async () => {
    const biscuit = await db.person.create({ data: { name: "Biscuit", kind: "PET", species: "DOG", createdById: me } });
    await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(Array(512).fill(0.1))}::vector WHERE id = ${faceId}`;
    await nameClusterAs(clusterId, biscuit.id);
    expect(await db.face.findUniqueOrThrow({ where: { id: faceId } })).toMatchObject({ personId: biscuit.id, status: "CONFIRMED" });
    // A dog is spotted by the animal detector, never by face, so the template has no business being kept.
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE id = ${faceId} AND embedding IS NOT NULL`)[0].n).toBe(0);
    // No consent question was asked of a dog: nothing is waiting for an admin.
    expect((await db.person.findUniqueOrThrow({ where: { id: biscuit.id } })).pendingDecision).toBe(false);
  });

  it("will not hand faces to somebody who asked to be forgotten", async () => {
    const gone = await db.person.create({ data: { name: "Gone", optedOutAt: new Date(), createdById: me } });
    await expect(nameClusterAs(clusterId, gone.id)).rejects.toThrow(/forgotten/);
  });

  it("offers the named person a group most resembles", async () => {
    const jo = await db.person.create({ data: { name: "Grandma Jo", faceIndexing: true, adultAttestedAt: new Date(), adultAttestedById: me, createdById: me } });
    const hers = await db.faceCluster.create({ data: { personId: jo.id, label: "Grandma Jo", faceCount: 1 } });
    const like = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
    const alsoLike = Array.from({ length: 512 }, (_, i) => (i === 0 ? 0.99 : i === 1 ? 0.14 : 0));
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(like)}::vector WHERE id = ${hers.id}`;
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(alsoLike)}::vector WHERE id = ${clusterId}`;
    const [group] = await listUnnamedClusters();
    expect(group.looksLike).toMatchObject({ id: jo.id, name: "Grandma Jo", kind: "HUMAN" });

    // A group that resembles nobody is offered nobody, rather than the least unlike stranger.
    const unlike = Array.from({ length: 512 }, (_, i) => (i === 300 ? 1 : 0));
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(unlike)}::vector WHERE id = ${clusterId}`;
    expect((await listUnnamedClusters())[0].looksLike).toBeNull();
  });
});
