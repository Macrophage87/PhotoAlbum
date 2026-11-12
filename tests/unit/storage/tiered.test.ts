import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TieredStorage } from "@/lib/storage/tiered";
import { FakeRemote } from "./fake-remote";

async function text(s: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts).toString();
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "tiered-store-"));
  const remote = new FakeRemote();
  return { root, remote, store: new TieredStorage(root, remote, "live/") };
}

describe("tiered storage (Option 2)", () => {
  it("writes to disk, and moves an original to S3 under the install's prefix, freeing the disk only once S3 holds it whole", async () => {
    const { root, remote, store } = setup();
    await store.putBuffer("photos/c1/original.jpg", Buffer.from("hello world"));
    expect(remote.objects.size).toBe(0);
    expect(await store.offload("photos/c1/original.jpg", { storageClass: "STANDARD" })).toBe(11);
    expect(remote.objects.get("live/photos/c1/original.jpg")?.storageClass).toBe("STANDARD");
    expect(await store.evict("photos/c1/original.jpg")).toBe(true);
    expect(existsSync(path.join(root, "photos/c1/original.jpg"))).toBe(false);
  });

  it("refuses a short upload, and never frees the disk when S3's copy differs", async () => {
    const { root, remote, store } = setup();
    await store.putBuffer("photos/c1/original.jpg", Buffer.from("hello world"));
    remote.truncateNext = true;
    await expect(store.offload("photos/c1/original.jpg", { storageClass: "STANDARD" })).rejects.toThrow(/not the 11 on disk/);
    expect(await store.evict("photos/c1/original.jpg")).toBe(false);
    expect(existsSync(path.join(root, "photos/c1/original.jpg"))).toBe(true);
  });

  it("reads an original that is only in S3, whole or in part, and fetches it back for work with its own modified time", async () => {
    const { root, store } = setup();
    const file = path.join(root, "photos/c1/original.jpg");
    await store.putBuffer("photos/c1/original.jpg", Buffer.from("0123456789"));
    const taken = new Date("2019-06-01T10:00:00Z");
    utimesSync(file, taken, taken);
    await store.offload("photos/c1/original.jpg", { storageClass: "GLACIER_IR" });
    await store.evict("photos/c1/original.jpg");

    expect(await store.exists("photos/c1/original.jpg")).toBe(true);
    const whole = await store.getStream("photos/c1/original.jpg");
    expect(whole.size).toBe(10);
    expect(await text(whole.stream)).toBe("0123456789");
    const part = await store.getStream("photos/c1/original.jpg", { start: 2, end: 4 });
    expect(part.size).toBe(10);
    expect(await text(part.stream)).toBe("234");

    expect(await store.localFile("photos/c1/original.jpg")).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("0123456789");
    expect(statSync(file).mtime.toISOString()).toBe(taken.toISOString());
  });

  it("still says a file is missing when it is in neither place", async () => {
    const { store } = setup();
    await expect(store.getStream("photos/c1/medium.webp")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.localFile("photos/c1/original.jpg")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.exists("photos/c1/original.jpg")).toBe(false);
  });

  it("deletes an item's folder in both places, and never a neighbour whose id starts the same", async () => {
    const { remote, store } = setup();
    for (const id of ["c1", "c12"]) {
      await store.putBuffer(`photos/${id}/original.jpg`, Buffer.from(id));
      await store.offload(`photos/${id}/original.jpg`, { storageClass: "STANDARD" });
    }
    await store.deletePrefix("photos/c1");
    expect([...remote.objects.keys()]).toEqual(["live/photos/c12/original.jpg"]);
    expect(await store.exists("photos/c1/original.jpg")).toBe(false);
    await expect(store.deletePrefix("photos")).rejects.toThrow(/Refusing/);
  });

  it("needs a prefix that ends in a slash", () => {
    expect(() => new TieredStorage("/tmp/x", new FakeRemote(), "live")).toThrow(/must end in/);
  });
});
