import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** Who is acting: the next id in the queue, or the default. */
const who = vi.hoisted(() => ({ id: "", next: [] as string[], queued: [] as { queue: string; data: unknown }[], revoke: "revoked" as "revoked" | "failed" | "none" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.next.shift() ?? who.id, email: "a@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => void who.queued.push({ queue, data }) }));
vi.mock("@/lib/google/account", () => ({ revokeRemovedConnection: async (_: string, token: string | null) => (token ? who.revoke : "none") }));

import { removeMember } from "@/app/admin/actions";

describe("removing a member", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    who.queued = [];
    who.next = [];
    who.revoke = "revoked";
    admin = who.id = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const member = (email = "cousin@example.com", role: "MEMBER" | "ADMIN" = "MEMBER") => db.user.create({ data: { email, role, name: "Cousin Pat" } });

  it("hands over tens of thousands of uploads and choices in one pass, well past a transaction's default five seconds", async () => {
    const m = await member();
    const N = 12_000;
    const rows = Array.from({ length: N }, (_, i) => ({ uploaderId: i % 2 ? m.id : admin, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, ...(i % 3 === 0 ? { dateSetById: m.id, takenAtSource: "MANUAL" as const } : {}), ...(i % 7 === 0 ? { placeSetById: m.id } : {}) }));
    for (let i = 0; i < N; i += 2000) await db.photo.createMany({ data: rows.slice(i, i + 2000) });
    await removeMember(m.id);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(N);
    expect(await db.photo.count({ where: { dateSetById: admin } })).toBe(Math.ceil(N / 3));
    expect(await db.photo.count({ where: { placeSetById: admin } })).toBe(Math.ceil(N / 7));
  }, 120_000);

  it("lets two admins removing each other at once remove only one, never the last admin", async () => {
    const other = await member("other@example.com", "ADMIN");
    who.next = [admin, other.id];
    const results = await Promise.allSettled([removeMember(other.id), removeMember(admin)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/no longer an admin/) }) });
    expect(await db.user.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it("is nothing to do when the member is already gone, twice at once included", async () => {
    const m = await member();
    await Promise.all([removeMember(m.id), removeMember(m.id)]);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    await expect(removeMember(m.id)).resolves.toBeUndefined();
  });

  it("refuses an acting admin who was demoted meanwhile", async () => {
    const m = await member();
    await db.user.update({ where: { id: admin }, data: { role: "MEMBER" } });
    await expect(removeMember(m.id)).rejects.toThrow(/no longer an admin/);
    expect(await db.user.count({ where: { id: m.id } })).toBe(1);
  });

  it("takes their judged name with them, and queues the revocation again when Google cannot be told", async () => {
    const m = await member();
    await db.appSetting.create({ data: { id: "app", membersOnlyNames: [`user:${m.id}:Cousin Pat`, `user:${admin}:Dana`] } });
    await db.googleAccount.create({ data: { userId: m.id, encryptedRefreshToken: "sealed" } });
    who.revoke = "failed";
    await removeMember(m.id);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyNames).toEqual([`user:${admin}:Dana`]);
    expect(await db.googleAccount.count()).toBe(0);
    expect(who.queued).toEqual([{ queue: "revoke-google", data: { encryptedRefreshToken: "sealed" } }]);
  });
});
