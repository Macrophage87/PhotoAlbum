import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { db } from "@/lib/db";
import { vectorLiteral } from "@/lib/ml/client";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "admin@example.com", name: "Admin", role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { decideIndexing, tagPersonAt } from "@/app/people/actions";
import { deleteRescannedFaces, rebuildCentroids } from "@/lib/jobs/handlers/detect-faces";
import { confirmFaceAs } from "@/lib/people/matching";

async function waitBlocked(other: Client) {
  const pid = (await other.query("SELECT pg_backend_pid() AS p")).rows[0].p;
  for (let i = 0; i < 100; i++) {
    const r = await other.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [pid]);
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("never blocked");
}

/** Two connections at once, as the face-locks review ran them: no deadlock, and no template kept for somebody switched off. */
describe("recognition switched off while templates are rebuilt", () => {
  let photoId: string, personId: string, clusterId: string, faceId: string;
  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: who.id, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    personId = (await db.person.create({ data: { name: "Jo", faceIndexing: true, adultAttestedAt: new Date(), createdById: who.id } })).id;
    clusterId = (await db.faceCluster.create({ data: { personId, faceCount: 1 }, select: { id: true } })).id;
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(Array(512).fill(0.1))}::vector WHERE id = ${clusterId}`;
    faceId = (await db.face.create({ data: { photoId, personId, clusterId, box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, status: "CONFIRMED" }, select: { id: true } })).id;
    await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(Array(512).fill(0.1))}::vector WHERE id = ${faceId}`;
  });

  it("switch-off and leaveCluster (group then face) do not deadlock", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let bErr: unknown = null;
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM "FaceCluster" WHERE id = $1 FOR UPDATE`, [clusterId]);
      const off = decideIndexing(personId, new FormData()).then(() => null, (e) => e);
      await waitBlocked(other);
      try {
        await other.query(`UPDATE "Face" SET "clusterId" = NULL WHERE id = $1`, [faceId]);
        await other.query("COMMIT");
      } catch (e) {
        bErr = e;
        await other.query("ROLLBACK");
      }
      const aErr = await off;
      expect(String(bErr ?? "")).not.toMatch(/deadlock/);
      expect(String(aErr ?? "")).not.toMatch(/deadlock/);
    } finally {
      await other.end();
    }
  });

  it("rebuildCentroids after a restore does not bring a centroid back for somebody switched off meanwhile", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      // decideIndexing's transaction, the new order.
      await other.query(`UPDATE "Person" SET "faceIndexing" = false WHERE id = $1`, [personId]);
      await other.query(`UPDATE "FaceCluster" SET centroid = NULL WHERE "personId" = $1`, [personId]);
      await other.query(`UPDATE "Face" SET embedding = NULL WHERE "personId" = $1`, [personId]);
      const rebuilding = rebuildCentroids(personId);
      await waitBlocked(other);
      await other.query("COMMIT");
      await rebuilding;
    } finally {
      await other.end();
    }
    expect((await db.person.findUniqueOrThrow({ where: { id: personId } })).faceIndexing).toBe(false);
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE "personId" = ${personId} AND embedding IS NOT NULL`)[0].n).toBe(0);
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "FaceCluster" WHERE "personId" = ${personId} AND centroid IS NOT NULL`)[0].n).toBe(0);
  });
  it("confirming a leftover proposal for somebody being forgotten is refused", async () => {
    const open = (await db.face.create({ data: { photoId, proposedPersonId: personId, box: [0.5, 0.5, 0.2, 0.2], confidence: 0.9, status: "PROPOSED" }, select: { id: true } })).id;
    await db.person.update({ where: { id: personId }, data: { forgetPendingAt: new Date() } });
    await expect(confirmFaceAs(open, personId)).rejects.toThrow(/forgotten/);
    expect(await db.face.findUniqueOrThrow({ where: { id: open } })).toMatchObject({ personId: null, status: "PROPOSED" });
  });
});

/** Detection's re-scan delete, the job's own: faces locked in id order, as naming locks them. */
describe("re-scan delete", () => {
  const del = deleteRescannedFaces;
  let photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    const u = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: u, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    // Heap order z then a; id order a then z.
    for (const id of ["zzzz", "aaaa"]) await db.face.create({ data: { id, photoId, box: [0, 0, 0.1, 0.1], confidence: 0.9, status: "DETECTED" } });
  });
  it("waits for naming instead of deadlocking", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let bErr: unknown = null;
    try {
      await other.query("BEGIN");
      await other.query(`SELECT id FROM "Face" WHERE id = 'aaaa' FOR UPDATE`);
      const d = del(photoId).then(() => null, (e) => e);
      await waitBlocked(other);
      try {
        await other.query(`SELECT id FROM "Face" WHERE id = 'zzzz' FOR UPDATE`);
        await other.query("COMMIT");
      } catch (e) {
        bErr = e;
        await other.query("ROLLBACK");
      }
      const aErr = await d;
      expect(String(bErr ?? "") + String(aErr ?? "")).not.toMatch(/deadlock/);
    } finally {
      await other.end();
    }
  });
});

describe("a forget begun, and the tags and confirms that come after it", () => {
  let admin: string, photoId: string, personId: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.id = admin;
    photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    personId = (await db.person.create({ data: { name: "Jo", createdById: admin } })).id;
  });

  it("a refused confirm leaves the face in its group", async () => {
    const cluster = (await db.faceCluster.create({ data: { faceCount: 2 }, select: { id: true } })).id;
    const face = (await db.face.create({ data: { photoId, clusterId: cluster, proposedPersonId: personId, box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, status: "PROPOSED" }, select: { id: true } })).id;
    await db.face.create({ data: { photoId, clusterId: cluster, box: [0.5, 0.5, 0.2, 0.2], confidence: 0.9, status: "DETECTED" } });
    await db.person.update({ where: { id: personId }, data: { optedOutAt: new Date() } });
    await expect(confirmFaceAs(face, personId)).rejects.toThrow(/forgotten/);
    expect((await db.face.findUniqueOrThrow({ where: { id: face } })).clusterId).toBe(cluster);
  });

  it("a hand tag waits for a forget's switch-off and is then refused", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`UPDATE "Person" SET "optedOutAt" = now(), "forgetPendingAt" = now() WHERE id = $1`, [personId]);
      const fd = new FormData();
      fd.set("personId", personId);
      fd.set("box", JSON.stringify([0.1, 0.1, 0.2, 0.2]));
      const tagging = tagPersonAt(photoId, fd).then(() => null, (e: unknown) => e);
      await waitBlocked(other);
      await other.query("COMMIT");
      expect(String(await tagging)).toMatch(/forgotten/);
    } finally {
      await other.end();
    }
    expect(await db.face.count({ where: { personId } })).toBe(0);
  });
});
