import { describe, expect, it } from "vitest";
import { backoffMs, failureForStatus, isRetryable, MAX_ATTEMPTS, MAX_BATCH, overCapMessage, progressLine, STATUS_NOTICE_AFTER, STATUS_POLL_MS, statusRetryMs } from "@/lib/media/upload-retry";

/**
 * A hundred photographs from a phone take minutes, and in those minutes the screen locks and the network hands
 * over. What the connection loses is worth another go; what the album refused is not.
 */
describe("deciding whether an upload is worth another go", () => {
  it("tries again when the connection went away", () => {
    expect(isRetryable({ kind: "network", message: "" })).toBe(true);
    expect(isRetryable({ kind: "stalled", message: "" })).toBe(true);
  });

  it("tries again when the album was busy or broken, but not when it said no", () => {
    expect(isRetryable(failureForStatus(503))).toBe(true);
    expect(isRetryable(failureForStatus(429))).toBe(true);
    expect(isRetryable(failureForStatus(415, "Unsupported file type: notes.pdf"))).toBe(false);
    expect(isRetryable(failureForStatus(413, "File is larger than 100 MB"))).toBe(false);
  });

  it("treats a browser that abandoned the request as a dropped connection, not a refusal", () => {
    // A phone locking its screen ends the request with no status at all.
    expect(failureForStatus(0).kind).toBe("network");
    expect(isRetryable(failureForStatus(0))).toBe(true);
  });

  it("stops trying once the member is signed out, and says so", () => {
    const signedOut = failureForStatus(401);
    expect(signedOut.kind).toBe("signedout");
    expect(isRetryable(signedOut)).toBe(false);
    expect(signedOut.message).toMatch(/sign in again/i);
  });

  it("keeps what the album said about a refusal, rather than replacing it with something vaguer", () => {
    expect(failureForStatus(415, "Unsupported file type: notes.pdf").message).toContain("notes.pdf");
  });

  it("waits longer each time, and gives every file the same number of goes", () => {
    const waits = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1));
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe("saying how a batch is going", () => {
  it("counts up while it runs", () => {
    expect(progressLine({ done: 37, failed: 0, waiting: 0, inFlight: 3, total: 100 })).toBe("37 of 100 uploaded…");
  });

  it("says when something is waiting on the connection rather than looking stuck", () => {
    expect(progressLine({ done: 37, failed: 0, waiting: 2, inFlight: 1, total: 100 })).toContain("2 waiting to try again");
  });

  it("says plainly at the end how many did not make it", () => {
    expect(progressLine({ done: 88, failed: 12, waiting: 0, inFlight: 0, total: 100 })).toBe("88 of 100 uploaded; 12 did not.");
    expect(progressLine({ done: 100, failed: 0, waiting: 0, inFlight: 0, total: 100 })).toBe("All 100 uploaded.");
  });
});

describe("a batch that has arrived but is still being processed", () => {
  it("counts the ready ones too, so minutes of processing do not read as a page that has stopped", () => {
    expect(progressLine({ done: 100, failed: 0, waiting: 0, inFlight: 0, total: 100, ready: 57, processing: 43 })).toBe("All 100 uploaded. 57 ready, 43 still being processed…");
  });

  it("says the same once everything is ready as it always did", () => {
    expect(progressLine({ done: 100, failed: 0, waiting: 0, inFlight: 0, total: 100, ready: 100, processing: 0 })).toBe("All 100 uploaded.");
  });

  it("keeps what did not arrive in the sentence while the rest are processed", () => {
    expect(progressLine({ done: 98, failed: 2, waiting: 0, inFlight: 0, total: 100, ready: 60, processing: 38 })).toBe("98 of 100 uploaded; 2 did not. 60 ready, 38 still being processed…");
  });
});

describe("asking how processing is going", () => {
  it("asks often while the answers come back", () => {
    expect(statusRetryMs(0)).toBe(STATUS_POLL_MS);
  });

  it("waits longer after each missed answer, and never stops asking", () => {
    // A missed answer is a phone locking its screen, not a failed photograph: back off, keep going.
    const waits = [1, 2, 3, 4, 10, 100].map(statusRetryMs);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[waits.length - 1]).toBeLessThanOrEqual(30_000);
    expect(waits.every((w) => w > STATUS_POLL_MS)).toBe(true);
  });

  it("only mentions it once several answers in a row have gone missing", () => {
    expect(STATUS_NOTICE_AFTER).toBeGreaterThan(1);
  });
});

describe("the most one batch takes", () => {
  it("is enough for a big afternoon, and says what happened to the rest", () => {
    expect(MAX_BATCH).toBeGreaterThanOrEqual(100);
    expect(overCapMessage(1)).toBe(`1 more was not added: the album takes up to ${MAX_BATCH} at a time. Add it once these have finished.`);
    expect(overCapMessage(37)).toContain("37 more were not added");
    expect(overCapMessage(37)).toContain("Add them once these have finished.");
  });
});
