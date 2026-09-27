import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { db } from "@/lib/db";
import { normalise } from "@/lib/people/cluster";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "faces-races-"));
vi.hoisted(() => { process.env.ML_URL = "http://ml.test"; process.env.ML_TOKEN = "t"; process.env.FACE_INDEXING_ENABLED = "true"; });
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "admin@example.com", name: "Admin", role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const ml = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("@/lib/ml/client", async (orig) => ({ ...(await orig()) as object, detectFaces: ml.detect }));

import { detectFacesJob } from "@/lib/jobs/handlers/detect-faces";
import { decideIndexing } from "@/app/people/actions";

async function waitBlocked(other: Client) {
  const pid = (await other.query("SELECT pg_backend_pid() AS p")).rows[0].p;
  for (let i = 0; i < 200; i++) {
    const r = await other.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [pid]);
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("never blocked");
}
const BOX: [number, number, number, number] = [0.3, 0.3, 0.2, 0.2];
const vec = normalise(Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)));

/** Detection's restore and an admin's switch-on, each racing another connection (the face-locks review's probes). */
describe("the restore and the switch-on, under the person's lock", () => {
  let personId: string, photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    ml.detect.mockReset();
    who.id = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    await db.appSetting.create({ data: { id: "app", faceDetectionOptInAt: new Date(), faceDetectionOptInById: who.id } });
    personId = (await db.person.create({ data: { name: "Jo", faceIndexing: true, adultAttestedAt: new Date(), createdById: who.id } })).id;
    const key = "photos/rv";
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    writeFileSync(path.join(photoRoot, key, "medium.webp"), "x");
    photoId = (await db.photo.create({ data: { uploaderId: who.id, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/o.jpg`, sizeBytes: 1, status: "READY", renditions: { medium: { key: `${key}/medium.webp`, w: 10, h: 10 } } } })).id;
  });

  it("S2: a face untagged while the restore waits gets no template and joins no era", async () => {
    const faceId = (await db.face.create({ data: { photoId, personId, box: BOX, confidence: 0.9, status: "CONFIRMED" }, select: { id: true } })).id;
    ml.detect.mockResolvedValue([{ box: BOX, confidence: 0.9, embedding: vec, age: 30 }]);
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM "Person" WHERE id = $1 FOR UPDATE`, [personId]);
      const job = detectFacesJob({ photoId });
      await waitBlocked(other);
      // untagPerson: the face is "not them" now.
      await other.query(`UPDATE "Face" SET "personId" = NULL, status = 'REJECTED', "proposedPersonId" = $1, "clusterId" = NULL WHERE id = $2`, [personId, faceId]);
      await other.query("COMMIT");
      await job;
    } finally { await other.end(); }
    const f = (await db.$queryRaw<{ e: boolean; c: string | null }[]>`SELECT embedding IS NOT NULL AS e, "clusterId" AS c FROM "Face" WHERE id = ${faceId}`)[0];
    expect(f.c).toBeNull();
    expect(await db.faceCluster.count({ where: { personId } })).toBe(0);
  });

  it("S3: a switch-on racing a forget's switch-off does not turn them back on", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`UPDATE "Person" SET "faceIndexing" = false, "optedOutAt" = now(), "forgetPendingAt" = now() WHERE id = $1`, [personId]);
      const fd = new FormData(); fd.set("faceIndexing", "on"); fd.set("attest", "on");
      const on = decideIndexing(personId, fd).then(() => null, (e) => e);
      await waitBlocked(other);
      await other.query("COMMIT");
      await on;
    } finally { await other.end(); }
    expect((await db.person.findUniqueOrThrow({ where: { id: personId } })).faceIndexing).toBe(false);
  });
});
