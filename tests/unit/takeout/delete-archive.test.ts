import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const inbox = mkdtempSync(path.join(tmpdir(), "inbox-del-"));
process.env.IMPORT_INBOX_DIR = inbox;
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "a@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));

import { deleteTakeoutArchive } from "@/app/admin/actions";

describe("deleting a Takeout archive from the Admin page", () => {
  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
    writeFileSync(path.join(inbox, "takeout-001.zip"), "zip");
  });
  it("refuses while an import is reading it, and deletes it once that is over", async () => {
    const run = await db.takeoutImport.create({ data: { archiveName: "takeout-001.zip", startedById: who.id, heartbeatAt: new Date() } });
    expect(await deleteTakeoutArchive("takeout-001.zip")).toMatch(/being imported/);
    expect(existsSync(path.join(inbox, "takeout-001.zip"))).toBe(true);
    await db.takeoutImport.update({ where: { id: run.id }, data: { status: "ENDED" } });
    expect(await deleteTakeoutArchive("takeout-001.zip")).toBeNull();
    expect(existsSync(path.join(inbox, "takeout-001.zip"))).toBe(false);
  });
});
