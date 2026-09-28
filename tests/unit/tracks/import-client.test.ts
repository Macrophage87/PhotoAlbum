import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTrackFile, waitForImport } from "@/lib/tracks/import-client";

/** Just enough XMLHttpRequest to be driven by hand. */
function fakeXhr() {
  const handlers: Record<string, (() => void) | undefined> = {};
  class FakeXhr {
    upload = {};
    status = 0;
    responseText = "";
    set onload(fn: () => void) { handlers.load = fn; }
    set onerror(fn: () => void) { handlers.error = fn; }
    set onabort(fn: () => void) { handlers.abort = fn; }
    set ontimeout(fn: () => void) { handlers.timeout = fn; }
    open() {}
    setRequestHeader() {}
    send() {}
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return { fire: (name: string) => handlers[name]?.() };
}

const file = { name: "ride.fit" } as File;
const send = () => sendTrackFile(file, "trip", "auto", false, () => {});
/** Answers from the poll route, one per question; `null` is a question that got no answer at all. */
function answers(...list: (null | { status: number; body?: unknown })[]) {
  const fetch = vi.fn(async () => {
    const a = list.shift();
    if (a === undefined) throw new Error("asked more often than expected");
    if (a === null) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const noWait = async () => {};

afterEach(() => vi.unstubAllGlobals());

describe("sending a track file", () => {
  it("fails with a reason, rather than hanging on 'Uploading', when the phone abandons the request", async () => {
    const x = fakeXhr();
    const p = send();
    x.fire("abort");
    await expect(p).rejects.toThrow(/interrupted/);
  });

  it("fails with a reason when the request times out", async () => {
    const x = fakeXhr();
    const p = send();
    x.fire("timeout");
    await expect(p).rejects.toThrow(/too long/);
  });
});

describe("waiting for an import", () => {
  const done = { status: 200, body: { state: "completed", summary: { kind: "fit", tracks: [], skipped: [], pointsRead: 3 }, error: null } };

  it("keeps asking through missed answers, and says so while it does", async () => {
    const fetch = answers(null, { status: 502 }, { status: 200, body: { state: "active", summary: null, error: null } }, done);
    const trouble: boolean[] = [];
    const sleeps: number[] = [];
    const summary = await waitForImport("job", { sleep: async (ms) => void sleeps.push(ms), onTrouble: (t) => trouble.push(t) });
    expect(summary.pointsRead).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(trouble).toEqual([true, true, false]);
    // Longer after each miss, back to the usual pace once an answer comes.
    expect(sleeps[1]).toBeLessThan(sleeps[2]);
    expect(sleeps[3]).toBe(1000);
  });

  it("ends with the server's reason when the import failed", async () => {
    answers({ status: 200, body: { state: "failed", summary: null, error: "This FIT file is incomplete or damaged." } });
    await expect(waitForImport("job", { sleep: noWait })).rejects.toThrow("This FIT file is incomplete or damaged.");
  });

  it("stops asking once the member is signed out", async () => {
    answers({ status: 401 });
    await expect(waitForImport("job", { sleep: noWait })).rejects.toThrow(/signed out/);
  });

  it("gives up only once the import itself would have been stopped", async () => {
    let t = 0;
    answers(...Array.from({ length: 50 }, () => null));
    await expect(waitForImport("job", { sleep: async (ms) => void (t += ms * 100), now: () => t })).rejects.toThrow(/Timed out/);
  });
});
