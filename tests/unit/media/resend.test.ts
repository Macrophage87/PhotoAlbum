import { describe, expect, it } from "vitest";
import { isResend, RESEND_WINDOW_MS } from "@/lib/media/resend";

const now = Date.parse("2026-09-26T12:00:00Z");
const mine = { uploaderId: "me", originalName: "beach.jpg", createdAt: new Date(now - 60_000) };

describe("a retry that found its own earlier attempt", () => {
  it("is the member's own recent upload of the same name, on a second or later attempt", () => {
    expect(isResend(mine, 2, "me", "beach.jpg", now)).toBe(true);
  });
  it("is not a first attempt, somebody else's, another name, or an old one", () => {
    expect(isResend(mine, 1, "me", "beach.jpg", now)).toBe(false);
    expect(isResend(mine, 2, "someone-else", "beach.jpg", now)).toBe(false);
    expect(isResend(mine, 2, "me", "beach (1).jpg", now)).toBe(false);
    expect(isResend({ ...mine, createdAt: new Date(now - RESEND_WINDOW_MS - 1000) }, 3, "me", "beach.jpg", now)).toBe(false);
  });
});
