import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { LocalStorage } from "@/lib/storage/local";

describe("a refused file in local storage", () => {
  it("takes its own empty photos/<id>/ folder with it, but never a shared folder such as imports/", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "local-store-"));
    const store = new LocalStorage(root);
    await expect(store.putStream("photos/abc/original.jpg", Readable.from([Buffer.alloc(20)]), { maxBytes: 10 })).rejects.toThrow();
    expect(existsSync(path.join(root, "photos/abc"))).toBe(false);
    await expect(store.putStream("imports/x.gpx", Readable.from([Buffer.alloc(20)]), { maxBytes: 10 })).rejects.toThrow();
    expect(existsSync(path.join(root, "imports"))).toBe(true);
    expect(existsSync(path.join(root, "imports/x.gpx"))).toBe(false);
  });
});
