import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { normalise } from "@/lib/people/cluster";
import { vectorLiteral } from "@/lib/ml/client";
import { proposalsFor } from "@/lib/people/queries";
import type { Prisma } from "@/generated/prisma/client";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "cluster-races-"));
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
  process.env.FACE_INDEXING_ENABLED = "true";
});
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const who = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const ml = vi.hoisted(() => ({ detect: vi.fn() }));
// A seam in the database client, transactions included: every raw query's text is recorded; after one whose text
// includes `match`, `then` runs before it answers; and while `fail` is above zero, the photographs' lock throws the
// error Prisma gives a transaction the database chose to break a deadlock.
const seam = vi.hoisted(() => ({ match: "", then: null as null | (() => Promise<void>), seen: [] as string[], fail: 0 }));
vi.mock("@/lib/db", async (orig) => {
  const real = ((await orig()) as { db: object }).db;
  type Client = Record<string | symbol, unknown>;
  const rawOf = (t: Client) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    seam.seen.push(text);
    if (seam.fail > 0 && text.includes("FOR NO KEY UPDATE")) {
      seam.fail--;
      throw Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), { code: "P2034" });
    }
    const out = await (t.$queryRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>).call(t, strings, ...values);
    if (seam.then && seam.match && text.includes(seam.match)) {
      const then = seam.then;
      seam.then = null;
      await then();
    }
    return out;
  };
  const wrap = (client: Client): Client =>
    new Proxy(client, {
      get: (t, k) => {
        if (k === "$queryRaw") return rawOf(t);
        if (k === "$transaction") return (fn: unknown, opts?: unknown) => (t.$transaction as (f: unknown, o?: unknown) => Promise<unknown>).call(t, typeof fn === "function" ? (tx: Client) => (fn as (c: Client) => unknown)(wrap(tx)) : fn, opts);
        return typeof t[k] === "function" ? (t[k] as (...a: unknown[]) => unknown).bind(t) : t[k];
      },
    });
  return { db: wrap(real as Client) };
});
vi.mock("@/lib/ml/client", async (orig) => ({ ...(await orig()) as object, detectFaces: ml.detect }));

import { nameCluster, nameClusterAs } from "@/app/people/actions";
import { detectFacesJob } from "@/lib/jobs/handlers/detect-faces";
import { updatedCentroid } from "@/lib/people/cluster";

/** Unit vectors near the first axis, so they group together. */
const near = (tilt: number) => normalise(Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0)));

/** Until somebody else's statement is queued behind a row lock this test holds. */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nobody ever waited for the lock");
}

/**
 * Hold a group's row the way naming does, start `meanwhile` (which should queue behind it), make `change` as the
 * other party would, and let go. What `meanwhile` then does is what the album does when two people act at once.
 */
async function interleave(clusterId: string, meanwhile: () => Promise<unknown>, change: (tx: Prisma.TransactionClient) => Promise<void>) {
  let pending!: Promise<{ error?: Error }>;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FaceCluster" WHERE id = ${clusterId} FOR UPDATE`;
    pending = meanwhile().then(() => ({}), (error: Error) => ({ error }));
    await someoneWaits();
    await change(tx);
  }, { timeout: 20_000 });
  return pending;
}

describe("two people acting on one group of faces at once", () => {
  let me: string, other: string, admin: string, mine: string, theirs: string, clusterId: string, myFace: string, theirFace: string, jo: string;
  const as = (id: string, role: "MEMBER" | "ADMIN" = "MEMBER") => { who.id = id; who.role = role; };
  const face = async (photoId: string, embedding: number[], extra: Record<string, unknown> = {}) => {
    const id = (await db.face.create({ data: { photoId, box: [0.3, 0.2, 0.2, 0.2], confidence: 0.9, status: "DETECTED", ...extra }, select: { id: true } })).id;
    await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(embedding)}::vector WHERE id = ${id}`;
    return id;
  };
  const centroid = async (id: string) => {
    const [row] = await db.$queryRaw<{ c: string | null; n: number }[]>`SELECT centroid::text AS c, "faceCount" AS n FROM "FaceCluster" WHERE id = ${id}`;
    return { centroid: row.c ? (JSON.parse(row.c) as number[]) : null, faceCount: row.n };
  };

  beforeEach(async () => {
    await resetTestDb();
    ml.detect.mockReset();
    seam.seen = [];
    seam.fail = 0;
    seam.then = null;
    me = (await db.user.create({ data: { email: "me@example.com", role: "MEMBER" } })).id;
    other = (await db.user.create({ data: { email: "other@example.com", role: "MEMBER" } })).id;
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    await db.appSetting.create({ data: { id: "app", faceDetectionOptInAt: new Date(), faceDetectionOptInById: admin } });
    const photo = async (uploaderId: string, key: string) => {
      mkdirSync(path.join(photoRoot, key), { recursive: true });
      writeFileSync(path.join(photoRoot, key, "medium.webp"), "x");
      return (await db.photo.create({ data: { uploaderId, originalName: `${key}.jpg`, mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/o.jpg`, sizeBytes: 1, status: "READY", width: 1200, height: 800, renditions: { medium: { key: `${key}/medium.webp`, w: 10, h: 10 } } } })).id;
    };
    mine = await photo(me, "mine");
    theirs = await photo(other, "theirs");
    clusterId = (await db.faceCluster.create({ data: { faceCount: 2 } })).id;
    myFace = await face(mine, near(0), { clusterId });
    theirFace = await face(theirs, near(0.6), { clusterId });
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(normalise(near(0).map((x, i) => x + near(0.6)[i])))}::vector WHERE id = ${clusterId}`;
    // Recognised, so a named group keeps its centre and the carve's arithmetic can be seen.
    jo = (await db.person.create({ data: { name: "Grandma Jo", faceIndexing: true, adultAttestedAt: new Date(), adultAttestedById: admin, createdById: admin } })).id;
  });

  it("an admin naming the group while a member carves their face out names only what is left", async () => {
    const amy = (await db.person.create({ data: { name: "Cousin Amy", createdById: me } })).id;
    as(admin, "ADMIN");
    const { error } = await interleave(clusterId, () => nameClusterAs(clusterId, jo), async (tx) => {
      // The member's carve, done first: their face leaves for a group of its own, named Amy.
      const part = await tx.faceCluster.create({ data: { personId: amy, label: "Cousin Amy", faceCount: 1 } });
      await tx.face.update({ where: { id: myFace }, data: { clusterId: part.id, personId: amy, status: "CONFIRMED" } });
      await tx.faceCluster.update({ where: { id: clusterId }, data: { faceCount: 1 } });
    });
    expect(error).toBeUndefined();
    // Amy's face stays Amy's, in Amy's group; Jo is named on the face that was still in the group.
    const mineNow = await db.face.findUniqueOrThrow({ where: { id: myFace }, include: { cluster: true } });
    expect(mineNow.personId).toBe(amy);
    expect(mineNow.cluster?.personId).toBe(amy);
    expect(await db.face.findUniqueOrThrow({ where: { id: theirFace } })).toMatchObject({ personId: jo, clusterId });
  });

  it("a member naming the group while an admin names it finds it named, and makes nobody up", async () => {
    as(me);
    const fd = new FormData();
    fd.set("name", "Cousin Amy");
    const { error } = await interleave(clusterId, () => nameCluster(clusterId, fd), async (tx) => {
      await tx.faceCluster.update({ where: { id: clusterId }, data: { personId: jo, label: "Grandma Jo" } });
      await tx.face.updateMany({ where: { clusterId }, data: { personId: jo, status: "CONFIRMED" } });
    });
    expect(error?.message).toMatch(/already named/);
    expect(await db.person.count({ where: { name: "Cousin Amy" } })).toBe(0);
    expect(await db.face.count({ where: { personId: jo } })).toBe(2);
    expect(await db.faceCluster.count()).toBe(1);
  });

  it("a face detected while the group is being named starts a group of its own, and leaves the named one's centre alone", async () => {
    ml.detect.mockResolvedValue([{ box: [0.6, 0.6, 0.1, 0.1], confidence: 0.9, embedding: near(0.1), age: 30 }]);
    await db.face.deleteMany({ where: { id: theirFace } });
    await db.faceCluster.update({ where: { id: clusterId }, data: { faceCount: 1 } });
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(near(0))}::vector WHERE id = ${clusterId}`;
    const before = await centroid(clusterId);
    // The worst moment: detection has read the unnamed groups (this one among them) and not yet placed the face,
    // and the group is named just then.
    let named = false;
    seam.match = `FROM "FaceCluster" WHERE "personId" IS NULL AND centroid IS NOT NULL`;
    seam.then = async () => {
      named = true;
      await db.faceCluster.update({ where: { id: clusterId }, data: { personId: jo, label: "Grandma Jo" } });
      await db.face.updateMany({ where: { clusterId }, data: { personId: jo, status: "CONFIRMED" } });
    };
    await detectFacesJob({ photoId: theirs });
    expect(named).toBe(true);
    const found = await db.face.findFirstOrThrow({ where: { photoId: theirs }, include: { cluster: true } });
    // Not stranded, unnamed, inside Jo's group (where the purge would never find it): a group of its own, unnamed.
    expect(found.personId).toBeNull();
    expect(found.clusterId).not.toBe(clusterId);
    expect(found.cluster?.personId).toBeNull();
    expect(await centroid(clusterId)).toEqual(before);
  });

  it("adds a detected face to a group's centre as the group is when it is locked, not as it was first read", async () => {
    ml.detect.mockResolvedValue([{ box: [0.6, 0.6, 0.1, 0.1], confidence: 0.9, embedding: near(0.05), age: 30 }]);
    // Between detection reading the groups and placing its face, another face joins the group (a second scan,
    // say), moving its centre and its count.
    const moved = normalise(near(0).map((x, i) => x + near(0.6)[i]));
    seam.match = `FROM "FaceCluster" WHERE "personId" IS NULL AND centroid IS NOT NULL`;
    seam.then = async () => {
      await face(mine, near(0.6), { clusterId, box: [0.7, 0.7, 0.1, 0.1] });
      await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(moved)}::vector, "faceCount" = 2 WHERE id = ${clusterId}`;
    };
    // Scanning their photograph again: their old face goes first, leaving mine alone in the group.
    await detectFacesJob({ photoId: theirs });
    const found = await db.face.findFirstOrThrow({ where: { photoId: theirs } });
    expect(found.clusterId).toBe(clusterId);
    const after = await centroid(clusterId);
    expect(after.faceCount).toBe(3);
    const expected = updatedCentroid(moved, 2, near(0.05));
    after.centroid!.slice(0, 2).forEach((x, i) => expect(x).toBeCloseTo(expected[i], 5));
  });

  it("takes the photographs in one order before naming, so two groups sharing them are named one after the other", async () => {
    // Two groups, each with a face on both photographs, named at the same moment, several times over.
    for (let round = 0; round < 6; round++) {
      await db.face.deleteMany({});
      await db.faceCluster.deleteMany({});
      const groups: string[] = [];
      for (let g = 0; g < 2; g++) {
        const id = (await db.faceCluster.create({ data: { faceCount: 2 } })).id;
        await face(mine, near(g), { clusterId: id });
        await face(theirs, near(g), { clusterId: id });
        groups.push(id);
      }
      as(admin, "ADMIN");
      seam.seen = [];
      await Promise.all(groups.map((g) => nameClusterAs(g, jo)));
      expect(await db.face.count({ where: { personId: jo } })).toBe(4);
      expect(seam.seen.filter((q) => q.includes(`ORDER BY p.id FOR NO KEY UPDATE`))).toHaveLength(2);
    }
  });

  it("locks the group, then its faces, then their photographs, the order every other writer of faces takes", async () => {
    as(admin, "ADMIN");
    seam.seen = [];
    await nameClusterAs(clusterId, jo);
    const at = (needle: string) => seam.seen.findIndex((q) => q.includes(needle));
    const group = at(`FROM "FaceCluster" WHERE id = ? FOR UPDATE`);
    const faces = at(`FROM "Face" WHERE id = ANY(?) ORDER BY id FOR UPDATE`);
    const photos = at(`ORDER BY p.id FOR NO KEY UPDATE`);
    expect(group).toBeGreaterThanOrEqual(0);
    expect(faces).toBeGreaterThan(group);
    expect(photos).toBeGreaterThan(faces);
  });

  it("starts a group's centre from the new face when the group has none left, and recounts only the groups it lightened", async () => {
    ml.detect.mockResolvedValue([{ box: [0.6, 0.6, 0.1, 0.1], confidence: 0.9, embedding: near(0.05), age: 30 }]);
    const elsewhere = (await db.faceCluster.create({ data: { faceCount: 7 } })).id;
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(near(0.9))}::vector WHERE id = ${elsewhere}`;
    seam.match = `FROM "FaceCluster" WHERE "personId" IS NULL AND centroid IS NOT NULL`;
    seam.then = async () => {
      await db.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE "clusterId" = ${clusterId}`;
      await db.$executeRaw`UPDATE "FaceCluster" SET centroid = NULL WHERE id = ${clusterId}`;
    };
    await detectFacesJob({ photoId: theirs });
    const after = await centroid(clusterId);
    after.centroid!.slice(0, 2).forEach((x, i) => expect(x).toBeCloseTo(near(0.05)[i], 5));
    // A group this scan took nothing from keeps the count it had, right or wrong: it is not this scan's to redo.
    expect((await centroid(elsewhere)).faceCount).toBe(7);
  });

  it("tries once more when the database breaks a deadlock, and says so plainly if it happens again", async () => {
    as(admin, "ADMIN");
    seam.fail = 1;
    await nameClusterAs(clusterId, jo);
    expect(await db.face.count({ where: { personId: jo } })).toBe(2);
    const other = (await db.faceCluster.create({ data: { faceCount: 1 } })).id;
    await face(mine, near(0.3), { clusterId: other });
    seam.fail = 2;
    await expect(nameClusterAs(other, jo)).rejects.toThrow(/naming faces on the same photos/);
    // Nothing of the failed attempts stayed.
    expect((await db.faceCluster.findUniqueOrThrow({ where: { id: other } })).personId).toBeNull();
  });

  it("gives a carved-out group, and the group it left, centres made from their own faces", async () => {
    as(me);
    await nameClusterAs(clusterId, jo);
    const mineNow = await db.face.findUniqueOrThrow({ where: { id: myFace } });
    expect(mineNow).toMatchObject({ personId: jo });
    const carved = await centroid(mineNow.clusterId!);
    const left = await centroid(clusterId);
    expect(carved.faceCount).toBe(1);
    expect(left.faceCount).toBe(1);
    // Each is exactly its own face: the old centre, half of which was my face, would propose theirs as Jo at once.
    carved.centroid!.slice(0, 2).forEach((x, i) => expect(x).toBeCloseTo(near(0)[i], 5));
    left.centroid!.slice(0, 2).forEach((x, i) => expect(x).toBeCloseTo(near(0.6)[i], 5));
  });

  it("clears a proposal on a face its group's naming confirms", async () => {
    await db.face.update({ where: { id: myFace }, data: { status: "PROPOSED", proposedPersonId: jo } });
    as(me);
    const fd = new FormData();
    fd.set("name", "Cousin Amy");
    await nameCluster(clusterId, fd);
    expect(await db.face.findUniqueOrThrow({ where: { id: myFace } })).toMatchObject({ status: "CONFIRMED", proposedPersonId: null });
  });

  it("lists the proposals a member can answer first, even past a page of everybody else's older ones", async () => {
    await db.face.createMany({ data: Array.from({ length: 201 }, () => ({ photoId: theirs, box: [0.1, 0.1, 0.1, 0.1], confidence: 0.8, status: "PROPOSED" as const, proposedPersonId: jo })) });
    const answerable = (await db.face.create({ data: { photoId: mine, box: [0.5, 0.5, 0.1, 0.1], confidence: 0.8, status: "PROPOSED", proposedPersonId: jo } })).id;
    const rows = await proposalsFor(undefined, { id: me, role: "MEMBER" });
    expect(rows[0]).toMatchObject({ faceId: answerable, editable: true });
    expect(rows).toHaveLength(200);
    expect(rows.slice(1).every((r) => !r.editable)).toBe(true);
  });
});
