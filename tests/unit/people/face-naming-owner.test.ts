import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { NOT_YOURS } from "@/lib/auth/ownership";
import { listUnnamedClusters, proposalsFor } from "@/lib/people/queries";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { confirmProposal, markNotAFace, nameCluster, nameClusterAs, nameFace, rejectProposalAction, splitFaceFromCluster } from "@/app/people/actions";

/**
 * Saying who is in a photograph is changing what it says, so it follows the photograph: its uploader, and admins —
 * the rule a hand tag has always followed, now for the faces the album found as well.
 */
describe("naming the faces the album found", () => {
  let me: string, other: string, admin: string, mine: string, theirs: string, clusterId: string, myFace: string, theirFace: string, jo: string;
  const as = (id: string, role: "MEMBER" | "ADMIN" = "MEMBER") => { who.id = id; who.role = role; };
  const face = async (photoId: string, extra: Record<string, unknown> = {}) => (await db.face.create({ data: { photoId, box: [0.3, 0.2, 0.2, 0.2], confidence: 0.9, status: "DETECTED", ...extra }, select: { id: true } })).id;
  const named = (id: string) => db.face.findUniqueOrThrow({ where: { id }, select: { personId: true, status: true, clusterId: true } });

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "MEMBER" } })).id;
    other = (await db.user.create({ data: { email: "other@example.com", role: "MEMBER" } })).id;
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const photo = async (uploaderId: string, name: string) => (await db.photo.create({ data: { uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 1200, height: 800 } })).id;
    mine = await photo(me, "mine.jpg");
    theirs = await photo(other, "theirs.jpg");
    clusterId = (await db.faceCluster.create({ data: { faceCount: 2 } })).id;
    myFace = await face(mine, { clusterId });
    theirFace = await face(theirs, { clusterId });
    jo = (await db.person.create({ data: { name: "Grandma Jo", createdById: admin } })).id;
    as(me);
  });

  it("will not let a member name, disown or call not-a-face a face on somebody else's photograph", async () => {
    await expect(nameFace(theirFace, jo)).rejects.toThrow(NOT_YOURS);
    await expect(splitFaceFromCluster(theirFace)).rejects.toThrow(NOT_YOURS);
    await expect(markNotAFace(theirFace)).rejects.toThrow(NOT_YOURS);
    expect(await named(theirFace)).toMatchObject({ personId: null, status: "DETECTED", clusterId });
    // Their own, yes.
    await nameFace(myFace, jo);
    expect(await named(myFace)).toMatchObject({ personId: jo, status: "CONFIRMED" });
  });

  it("lets an admin do all of it on anybody's photograph", async () => {
    as(admin, "ADMIN");
    await splitFaceFromCluster(theirFace);
    await nameFace(theirFace, jo);
    expect(await named(theirFace)).toMatchObject({ personId: jo, status: "CONFIRMED" });
  });

  it("lets only the uploader or an admin answer a proposal, for a face or a spotted pet", async () => {
    const proposed = await face(theirs, { status: "PROPOSED", proposedPersonId: jo });
    const alsoMine = await face(mine, { status: "PROPOSED", proposedPersonId: jo });
    await expect(confirmProposal(proposed)).rejects.toThrow(NOT_YOURS);
    await expect(rejectProposalAction(proposed)).rejects.toThrow(NOT_YOURS);
    expect(await named(proposed)).toMatchObject({ personId: null, status: "PROPOSED" });
    await confirmProposal(alsoMine);
    expect(await named(alsoMine)).toMatchObject({ personId: jo, status: "CONFIRMED" });

    const rex = (await db.person.create({ data: { name: "Rex", kind: "PET", species: "DOG", createdById: other } })).id;
    const dog = (await db.animalDetection.create({ data: { photoId: theirs, species: "DOG", box: [0, 0, 0.5, 0.5], confidence: 0.9, status: "PROPOSED", proposedPersonId: rex } })).id;
    await expect(confirmProposal(`animal:${dog}`)).rejects.toThrow(NOT_YOURS);
    await expect(rejectProposalAction(`animal:${dog}`)).rejects.toThrow(NOT_YOURS);
    as(other);
    await confirmProposal(`animal:${dog}`);
    expect((await db.animalDetection.findUniqueOrThrow({ where: { id: dog } })).personId).toBe(rex);
  });

  it("names only a member's own faces in a group spread over several members' photographs; the rest wait together", async () => {
    const alsoTheirs = await face(theirs, { clusterId });
    await db.faceCluster.update({ where: { id: clusterId }, data: { faceCount: 3 } });
    const fd = new FormData();
    fd.set("name", "Cousin Amy");
    await nameCluster(clusterId, fd);
    const amy = await db.person.findFirstOrThrow({ where: { name: "Cousin Amy" } });
    const mineNow = await named(myFace);
    expect(mineNow).toMatchObject({ personId: amy.id, status: "CONFIRMED" });
    // A group of its own, named: the old one is not.
    expect(mineNow.clusterId).not.toBe(clusterId);
    expect((await db.faceCluster.findUniqueOrThrow({ where: { id: mineNow.clusterId! } })).personId).toBe(amy.id);
    const left = await db.faceCluster.findUniqueOrThrow({ where: { id: clusterId } });
    expect(left).toMatchObject({ personId: null, faceCount: 2 });
    for (const id of [theirFace, alsoTheirs]) expect(await named(id)).toMatchObject({ personId: null, status: "DETECTED", clusterId });

    // Their uploader names the rest the same way, joining them to the person already made.
    as(other);
    await nameClusterAs(clusterId, amy.id);
    for (const id of [theirFace, alsoTheirs]) expect(await named(id)).toMatchObject({ personId: amy.id, status: "CONFIRMED" });
  });

  it("refuses a group with none of the member's faces in it, and makes nobody up on the way", async () => {
    await splitFaceFromCluster(myFace);
    const fd = new FormData();
    fd.set("name", "Somebody New");
    await expect(nameCluster(clusterId, fd)).rejects.toThrow(NOT_YOURS);
    await expect(nameClusterAs(clusterId, jo)).rejects.toThrow(NOT_YOURS);
    expect(await db.person.count({ where: { name: "Somebody New" } })).toBe(0);
    expect(await named(theirFace)).toMatchObject({ personId: null, clusterId });
  });

  it("names a whole mixed group, as one, for an admin", async () => {
    as(admin, "ADMIN");
    await nameClusterAs(clusterId, jo);
    expect((await db.faceCluster.findUniqueOrThrow({ where: { id: clusterId } })).personId).toBe(jo);
    for (const id of [myFace, theirFace]) expect(await named(id)).toMatchObject({ personId: jo, clusterId });
  });

  it("tells the pages which faces and proposals this member may act on", async () => {
    const [group] = await listUnnamedClusters({ id: me, role: "MEMBER" });
    expect(group.editableCount).toBe(1);
    expect(Object.fromEntries(group.faces.map((f) => [f.faceId, f.editable]))).toEqual({ [myFace]: true, [theirFace]: false });
    expect((await listUnnamedClusters({ id: admin, role: "ADMIN" }))[0]).toMatchObject({ editableCount: 2 });

    const proposed = await face(theirs, { status: "PROPOSED", proposedPersonId: jo });
    expect((await proposalsFor(undefined, { id: me, role: "MEMBER" })).find((p) => p.faceId === proposed)?.editable).toBe(false);
    expect((await proposalsFor(undefined, { id: other, role: "MEMBER" })).find((p) => p.faceId === proposed)?.editable).toBe(true);
    expect((await proposalsFor(undefined, { id: admin, role: "ADMIN" })).find((p) => p.faceId === proposed)?.editable).toBe(true);
  });
});
