import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptError, attemptUpload } from "@/lib/media/upload-one";

/**
 * The one rule this has to keep: an attempt always finishes, whatever the browser does to it. The queue gives back
 * the slot an upload was using in a `finally`, so an attempt that never settles costs a slot for good — and three
 * of those stop a hundred-photograph batch dead, with every remaining tile saying "Waiting…" and nothing anywhere
 * saying why. That is the bug these guard.
 */

type Handlers = Record<string, (() => void) | undefined>;

/** Just enough XMLHttpRequest to be driven by hand. */
function fakeXhr() {
  const state = { sent: false, aborted: false, status: 0, responseText: "", handlers: {} as Handlers, upload: {} as { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } };
  class FakeXhr {
    upload = state.upload;
    status = 0;
    responseText = "";
    set onload(fn: () => void) { state.handlers.load = fn; }
    set onerror(fn: () => void) { state.handlers.error = fn; }
    set onabort(fn: () => void) { state.handlers.abort = fn; }
    set ontimeout(fn: () => void) { state.handlers.timeout = fn; }
    open() {}
    setRequestHeader() {}
    send() { state.sent = true; }
    abort() { state.aborted = true; }
  }
  const instance = { state, fire: (name: string, status = 0, body = "") => {
    const xhr = current!;
    xhr.status = status;
    xhr.responseText = body;
    state.handlers[name]?.();
  } };
  let current: FakeXhr | null = null;
  vi.stubGlobal("XMLHttpRequest", function (this: unknown) {
    current = new FakeXhr();
    return current;
  });
  return instance;
}

const file = { name: "beach.jpg", type: "image/jpeg", lastModified: 0 } as File;
/** The fake is already installed as the global by the time this is called. */
const start = () => attemptUpload(file, {}, false, () => {}, () => {});

afterEach(() => vi.unstubAllGlobals());

describe("one go at sending one file", () => {
  it("finishes when the browser abandons the request, rather than hanging for ever", async () => {
    const x = fakeXhr();
    const p = start();
    // What a phone does to whatever is in flight when its screen locks: neither load nor error, only abort.
    x.fire("abort");
    await expect(p).rejects.toBeInstanceOf(AttemptError);
    await expect(p).rejects.toMatchObject({ failure: { kind: "network" } });
  });

  it("finishes when the request times out", async () => {
    const x = fakeXhr();
    const p = start();
    x.fire("timeout");
    await expect(p).rejects.toMatchObject({ failure: { kind: "network" } });
  });

  it("finishes when the connection drops", async () => {
    const x = fakeXhr();
    const p = start();
    x.fire("error");
    await expect(p).rejects.toMatchObject({ failure: { kind: "network" } });
  });

  it("gives up on its own when the bytes stop moving, and stops the request", async () => {
    vi.useFakeTimers();
    const x = fakeXhr();
    const p = start();
    // Watch for the rejection before letting the clock run, or it lands with nobody listening.
    const rejected = expect(p).rejects.toMatchObject({ failure: { kind: "stalled" } });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(x.state.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("hands back what the album said when it refused the file", async () => {
    const x = fakeXhr();
    const p = start();
    x.fire("load", 415, JSON.stringify({ error: "Unsupported file type: notes.pdf" }));
    await expect(p).rejects.toMatchObject({ failure: { kind: "rejected", message: "Unsupported file type: notes.pdf" } });
  });

  it("treats an answer that is not the album's as a dropped connection, not a refusal", async () => {
    const x = fakeXhr();
    const p = start();
    // What a proxy in front of the album returns when it gives up: HTML, with no photo id in it.
    x.fire("load", 502, "<html>Bad Gateway</html>");
    await expect(p).rejects.toMatchObject({ failure: { kind: "server" } });
  });

  it("succeeds when the album takes it", async () => {
    const x = fakeXhr();
    const p = start();
    x.fire("load", 200, JSON.stringify({ photoId: "abc" }));
    await expect(p).resolves.toEqual({ photoId: "abc" });
  });

  it("ignores anything that arrives after it has already finished", async () => {
    const x = fakeXhr();
    const p = start();
    x.fire("load", 200, JSON.stringify({ photoId: "abc" }));
    x.fire("abort");
    await expect(p).resolves.toEqual({ photoId: "abc" });
  });
});
