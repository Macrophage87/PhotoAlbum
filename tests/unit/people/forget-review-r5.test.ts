import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { confirmFaceAs } from "@/lib/people/matching";
import { clearScrubStamps, stampForget } from "@/lib/people/names-changed";
import { completePendingForgets, forgetPerson } from "@/lib/people/forget-person";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/** Round five on 5d14285: the face-locks review's stamp clear and confirm probes, and the forget review's taggedOn. */
async function waitBlocked(other: Client) {
  const pid = (await other.query("SELECT pg_backend_pid() AS p")).rows[0].p;
  for (let i = 0; i < 200; i++) {
    const r = await other.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [pid]);
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("never blocked");
}

const record = (over: Partial<StoredAnnotation> = {}): StoredAnnotation => ({ title: "", caption: "", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", ...over });

describe("round five", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });
  const mk = (id: string, data: Record<string, unknown> = {}) => db.photo.create({ data: { id, uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: id, originalPath: `${id}/o.jpg`, sizeBytes: 1, status: "READY", namesScrubbedAt: new Date(), ...data } });

  it("a confirm racing a forget's switch-off is refused under the lock (the face-locks review's probe)", async () => {
    await mk("p1");
    const jo = await db.person.create({ data: { name: "Jo", faceIndexing: true, adultAttestedAt: new Date(), createdById: admin } });
    const f = (await db.face.create({ data: { photoId: "p1", proposedPersonId: jo.id, box: [0, 0, 0.1, 0.1], confidence: 0.9, status: "PROPOSED" } })).id;
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`UPDATE "Person" SET "faceIndexing" = false, "optedOutAt" = now(), "forgetPendingAt" = now() WHERE id = $1`, [jo.id]);
      const c = confirmFaceAs(f, jo.id).then(
        () => null,
        (e) => e,
      );
      await waitBlocked(other);
      await other.query("COMMIT");
      expect(String(await c)).toMatch(/forgotten/);
    } finally {
      await other.end();
    }
    expect((await db.face.findUniqueOrThrow({ where: { id: f } })).personId).toBeNull();
  });

  it("the album-wide stamp clear locks photographs in id order, as naming does, and never deadlocks with it", async () => {
    await mk("zz");
    await mk("aa");
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let bErr: unknown = null;
    try {
      await other.query("BEGIN");
      await other.query(`SELECT id FROM "Photo" WHERE id = 'aa' FOR NO KEY UPDATE`);
      const u = clearScrubStamps().then(
        () => null,
        (e) => e,
      );
      await waitBlocked(other);
      try {
        await other.query(`SELECT id FROM "Photo" WHERE id = 'zz' FOR NO KEY UPDATE`);
        await other.query("COMMIT");
      } catch (e) {
        bErr = e;
        await other.query("ROLLBACK");
      }
      expect(String(bErr ?? "") + String((await u) ?? "")).not.toMatch(/deadlock/);
    } finally {
      await other.end();
    }
    expect(await db.photo.count({ where: { namesScrubbedAt: { not: null } } })).toBe(0);
  });

  it("clears in batches, and the pending pass finishes a clear a forget did not: only stamps the last forget supersedes", async () => {
    for (let i = 0; i < 1203; i++) await mk(`p${String(i).padStart(4, "0")}`, { namesScrubbedAt: new Date(Date.now() - 60_000) });
    await stampForget();
    // An untagging after the forget: its stamp stays.
    const after = await mk("later");
    await db.$executeRaw`UPDATE "Photo" SET "namesScrubbedAt" = clock_timestamp() WHERE id = 'later'`;
    await completePendingForgets();
    expect(await db.photo.count({ where: { namesScrubbedAt: { not: null } } })).toBe(1);
    expect((await db.photo.findUniqueOrThrow({ where: { id: after.id } })).namesScrubbedAt).not.toBeNull();
  }, 60_000);

  it("uses the strict matcher only where she is tagged, not where the family turned the proposal down (the forget review)", async () => {
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin } });
    const hers = await mk("hers", { namesScrubbedAt: null, annotation: record({ caption: "ada waves" }), annotatedAt: new Date() });
    const next = await mk("next", { namesScrubbedAt: null, annotation: record({ caption: "ada from next door waves", tags: ["ada from next door"] }), annotatedAt: new Date() });
    await db.face.create({ data: { photoId: hers.id, personId: ada.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    // Proposed as her, and turned down: somebody else.
    await db.face.create({ data: { photoId: next.id, proposedPersonId: ada.id, status: "REJECTED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await forgetPerson(ada.id, { keepName: false, byUserId: admin });
    const read = async (id: string) => (await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation;
    expect((await read(hers.id)).caption).toBe("A family member waves");
    // (Its tags are judged by the language rules for a photograph she was proposed on, as at 4cae182.)
    expect((await read(next.id)).caption).toBe("ada from next door waves");
    // And in a later answer there.
    const ts = await loadTombstone();
    expect(ts.scrub("ada from next door waves", await forgottenScope({ photoIds: [next.id] }))).toBe("ada from next door waves");
    expect(ts.scrub("ada waves", await forgottenScope({ photoIds: [hers.id] }))).toBe("A family member waves");
  });

  it("a later answer on her photograph leaves a lake written as one, as the forget does (the language review's table_5)", async () => {
    const geneva = await db.person.create({ data: { name: "Geneva Holt", createdById: admin } });
    const p = await mk("g", { namesScrubbedAt: null });
    await db.face.create({ data: { photoId: p.id, personId: geneva.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await forgetPerson(geneva.id, { keepName: false, byUserId: admin });
    const scope = await forgottenScope({ photoIds: [p.id] });
    const ts = await loadTombstone();
    expect(ts.scrub("Lake day—Geneva at Lake Geneva.", scope)).toBe("Lake day—a family member at Lake Geneva.");
    expect(ts.scrub("Swimming in the lake Geneva loves.", scope)).toBe("Swimming in the lake a family member loves.");
  });

  it("uses the strict matcher on a confirmed photograph and on an open proposal, not a turned-down one (round six)", async () => {
    const tim = await db.person.create({ data: { name: "Timothy Kent", createdById: admin } });
    const confirmed = await mk("c", { namesScrubbedAt: null, annotation: record({ caption: "timothy waves" }), annotatedAt: new Date() });
    // Proposed because the notes name him, not yet decided.
    const proposed = await mk("p", { namesScrubbedAt: null, context: "Timothy at the lake", annotation: record({ caption: "timothy at the lake" }), annotatedAt: new Date() });
    const rejected = await mk("r", { namesScrubbedAt: null, annotation: record({ caption: "timothy from next door waves" }), annotatedAt: new Date() });
    await db.face.create({ data: { photoId: confirmed.id, personId: tim.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: proposed.id, proposedPersonId: tim.id, status: "PROPOSED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await db.face.create({ data: { photoId: rejected.id, proposedPersonId: tim.id, status: "REJECTED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await forgetPerson(tim.id, { keepName: false, byUserId: admin });
    const caption = async (id: string) => ((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption;
    expect([await caption(confirmed.id), await caption(proposed.id), await caption(rejected.id)]).toEqual(["A family member waves", "A family member at the lake", "timothy from next door waves"]);
    const ts = await loadTombstone();
    const later = async (id: string, t: string) => ts.scrub(t, await forgottenScope({ photoIds: [id] }));
    expect([await later(confirmed.id, "timothy waves at the lake"), await later(proposed.id, "timothy waves at the lake"), await later(rejected.id, "timothy from next door waves")]).toEqual(["A family member waves at the lake", "A family member waves at the lake", "timothy from next door waves"]);
  });

  it("the forget's clear takes only the stamps written before it began", async () => {
    await mk("old", { namesScrubbedAt: new Date(Date.now() - 60_000) });
    const started = await db.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    await mk("new");
    await db.$executeRaw`UPDATE "Photo" SET "namesScrubbedAt" = clock_timestamp() + interval '1 second' WHERE id = 'new'`;
    expect(started[0].t).toBeInstanceOf(Date);
    await clearScrubStamps();
    expect((await db.photo.findUniqueOrThrow({ where: { id: "old" } })).namesScrubbedAt).toBeNull();
    expect((await db.photo.findUniqueOrThrow({ where: { id: "new" } })).namesScrubbedAt).not.toBeNull();
  });

  it("finds her in a later answer inside quotes of either kind and inside a hashtag (round six)", async () => {
    const may = await db.person.create({ data: { name: "May Chen", createdById: admin } });
    const p = await mk("m", { namesScrubbedAt: null });
    await db.face.create({ data: { photoId: p.id, personId: may.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await forgetPerson(may.id, { keepName: false, byUserId: admin });
    const ts = await loadTombstone();
    const scope = await forgottenScope({ photoIds: [p.id] });
    for (const [t, want] of [
      ["‘May’ in glitter on her T-shirt.", "‘A family member’ in glitter on her T-shirt."],
      ["'May' in glitter on her T-shirt.", "'A family member' in glitter on her T-shirt."],
      ["“May.” Grandma said.", "“A family member.” Grandma said."],
      ["Cake says #happybirthdaymay", "Cake says a family member"],
      ["#MayTheBirthdayGirl", "A family member"],
    ]) expect([t, ts.scrub(t, scope)]).toEqual([t, want]);
    // Elsewhere a hashtag holding only her first name is not hers.
    expect(ts.scrub("#TeamMay", await forgottenScope({ photoIds: [(await mk("o")).id] }))).toBe("#TeamMay");
  });
});
