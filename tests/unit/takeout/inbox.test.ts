import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.IMPORT_INBOX_DIR = mkdtempSync(path.join(tmpdir(), "inbox-"));
const fsErr = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs/promises", async (orig) => {
  const real = (await orig()) as typeof import("node:fs/promises");
  return { ...real, unlink: async (p: string) => { if (fsErr.code) throw Object.assign(new Error(fsErr.code), { code: fsErr.code }); return real.unlink(p); } };
});

import { ArchiveDeleteError, deleteArchive } from "@/lib/takeout/inbox";

describe("deleting a Takeout archive", () => {
  it("says plainly when the inbox is not writable by the app, as on a volume Docker made root's", async () => {
    fsErr.code = "EACCES";
    const err = await deleteArchive("takeout-001.zip").catch((e) => e);
    expect(err).toBeInstanceOf(ArchiveDeleteError);
    expect(err.message).toMatch(/not writable by the app/);
  });
  it("says so when the archive is already gone", async () => {
    fsErr.code = null;
    await expect(deleteArchive("takeout-404.zip")).rejects.toThrow("takeout-404.zip is no longer in the inbox.");
  });
});
