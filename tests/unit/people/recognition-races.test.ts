import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { db } from "@/lib/db";
import { vectorLiteral } from "@/lib/ml/client";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { confirmFaceAs } from "@/lib/people/matching";

/** Recognition switched off by another connection while a face is being confirmed: the face keeps no template. */
describe("confirming a face while recognition is switched off", () => {
  let admin: string, photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  });

  it("reads the switch under a lock, so the face and its era keep no template", async () => {
    const jo = await db.person.create({ data: { name: "Jo", faceIndexing: true, adultAttestedAt: new Date(), createdById: admin } });
    const faceId = (await db.face.create({ data: { photoId, box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, status: "DETECTED" }, select: { id: true } })).id;
    await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(Array(512).fill(0.1))}::vector WHERE id = ${faceId}`;
    // An admin's switch, not yet committed when the confirm starts.
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      // decideIndexing's transaction: the switch and the templates nulled, before the face is theirs.
      await other.query(`UPDATE "Person" SET "faceIndexing" = false WHERE id = $1`, [jo.id]);
      await other.query(`UPDATE "FaceCluster" SET centroid = NULL WHERE "personId" = $1`, [jo.id]);
      await other.query(`UPDATE "Face" SET embedding = NULL WHERE "personId" = $1`, [jo.id]);
      const confirming = confirmFaceAs(faceId, jo.id);
      await new Promise((r) => setTimeout(r, 500));
      await other.query("COMMIT");
      await confirming;
    } finally {
      await other.end();
    }
    expect((await db.face.findUniqueOrThrow({ where: { id: faceId } })).personId).toBe(jo.id);
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE "personId" = ${jo.id} AND embedding IS NOT NULL`)[0].n).toBe(0);
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "FaceCluster" WHERE "personId" = ${jo.id} AND centroid IS NOT NULL`)[0].n).toBe(0);
  });
});
