import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const fail = vi.hoisted(() => ({ once: false, raw: false }));
vi.mock("@/lib/people/forget", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/people/forget");
  return {
    ...real,
    forgetRawAnswers: async (...args: Parameters<typeof real.forgetRawAnswers>) => {
      if (fail.raw) {
        fail.raw = false;
        throw new Error("connection lost");
      }
      return real.forgetRawAnswers(...args);
    },
  };
});
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
vi.mock("@/lib/annotation/rejudge", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/annotation/rejudge");
  return {
    ...real,
    forgetJudgedNames: async (...args: Parameters<typeof real.forgetJudgedNames>) => {
      if (fail.once) {
        fail.once = false;
        throw new Error("connection lost");
      }
      return real.forgetJudgedNames(...args);
    },
    dropRejudgeJobs: async () => {},
  };
});

import { completePendingForgets, forgetPerson } from "@/lib/people/forget-person";

describe("forgetting somebody on thousands of photographs", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    fail.once = false;
    fail.raw = false;
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });

  /** Somebody tagged on `n` photographs, one face each. */
  async function taggedOn(n: number) {
    const person = await db.person.create({ data: { name: "Zebulon Quince", createdById: admin } });
    const rows = Array.from({ length: n }, (_, i) => ({ id: `ph${String(i).padStart(6, "0")}`, uploaderId: admin, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, context: i === 0 ? "Zebulon Quince at the pier" : null }));
    for (let i = 0; i < n; i += 1000) await db.photo.createMany({ data: rows.slice(i, i + 1000) });
    for (let i = 0; i < n; i += 1000) await db.face.createMany({ data: rows.slice(i, i + 1000).map((r) => ({ photoId: r.id, personId: person.id, status: "CONFIRMED" as const, box: [0.1, 0.1, 0.2, 0.2], confidence: 0 })) });
    return person;
  }

  it("finishes, however many faces there are", async () => {
    const person = await taggedOn(5000);
    await forgetPerson(person.id, { keepName: false, byUserId: admin });
    expect(await db.person.count({ where: { id: person.id } })).toBe(0);
    expect(await db.face.count()).toBe(0);
    expect(await db.forgetLeftover.count()).toBe(1);
  }, 120_000);

  it("makes its leftover list when the pending pass finishes a forget cut short before it had one", async () => {
    const person = await taggedOn(3);
    await db.photo.update({ where: { id: "ph000001" }, data: { caption: "Zebulon Quince waves" } });
    const trip = await db.trip.create({ data: { slug: "zebulon-quince-80th", title: "The party", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: admin } });
    fail.raw = true;
    await expect(forgetPerson(person.id, { keepName: false, byUserId: admin })).rejects.toThrow("connection lost");
    expect(await db.forgetLeftover.count()).toBe(0);
    expect(await completePendingForgets()).toBe(1);
    expect(await db.person.count({ where: { id: person.id } })).toBe(0);
    const [left] = await db.forgetLeftover.findMany();
    expect(left.createdById).toBe(admin);
    const items = left.items as { photos: { id: string; fields: string[] }[]; trips: { id: string; fields: string[] }[] };
    expect(items.photos).toEqual(expect.arrayContaining([{ id: "ph000001", fields: ["caption"] }]));
    expect(items.trips).toEqual([{ id: trip.id, fields: ["web address"] }]);
  });

  it("is finished by the pending pass when it is cut short at the last step, never left with the name on the record", async () => {
    const person = await taggedOn(50);
    fail.once = true;
    await expect(forgetPerson(person.id, { keepName: false, byUserId: admin })).rejects.toThrow("connection lost");
    // Cut short: the record is still there, marked as waiting to be forgotten.
    expect((await db.person.findUniqueOrThrow({ where: { id: person.id } })).forgetPendingAt).not.toBeNull();
    expect(await completePendingForgets()).toBe(1);
    expect(await db.person.count({ where: { id: person.id } })).toBe(0);
    // The leftover list was made before anything was deleted, and only once.
    expect(await db.forgetLeftover.count()).toBe(1);
  });
});
