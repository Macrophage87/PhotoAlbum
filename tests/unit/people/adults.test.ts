import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { flagNewAdults } from "@/lib/jobs/handlers/detect-faces";
import { resetTestDb } from "../helpers/reset";

describe("the nightly adults job", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });

  it("lists people who turned 18 since their last decision, and nobody else", async () => {
    const y = new Date().getUTCFullYear();
    const eighteenLastMonth = new Date(Date.UTC(y - 18, new Date().getUTCMonth() - 1, 1));
    const decidedAsMinor = new Date(Date.UTC(y - 2, 0, 1));
    const grownUp = await db.person.create({ data: { name: "Grown up", birthday: eighteenLastMonth, faceIndexing: false, faceIndexingSetAt: decidedAsMinor, faceIndexingSetById: userId, createdById: userId } });
    const neverDecided = await db.person.create({ data: { name: "Never decided", birthday: eighteenLastMonth, createdById: userId } });
    const stillMinor = await db.person.create({ data: { name: "Still a minor", birthday: new Date(Date.UTC(y - 10, 0, 1)), createdById: userId } });
    const declinedAsAdult = await db.person.create({ data: { name: "Declined as adult", birthday: new Date(Date.UTC(y - 40, 0, 1)), faceIndexing: false, faceIndexingSetAt: new Date(), faceIndexingSetById: userId, createdById: userId } });
    const forgotten = await db.person.create({ data: { name: "Forgotten", birthday: eighteenLastMonth, optedOutAt: new Date(), createdById: userId } });
    expect(await flagNewAdults()).toBe(2);
    const pending = (await db.person.findMany({ where: { pendingDecision: true }, select: { id: true } })).map((p) => p.id).sort();
    expect(pending).toEqual([grownUp.id, neverDecided.id].sort());
    for (const id of [stillMinor.id, declinedAsAdult.id, forgotten.id]) expect((await db.person.findUniqueOrThrow({ where: { id } })).pendingDecision).toBe(false);
  });
});
