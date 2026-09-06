import { describe, expect, it } from "vitest";
import { canEditTrip, canViewTrip, visibleTripsWhere } from "@/lib/auth/access";
import type { Viewer } from "@/lib/auth/viewer";

const member: Viewer = { kind: "user", user: { id: "u1", email: "a@b.c", name: null, role: "MEMBER" }, shareTokens: new Map() };
const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });
const trip = (visibility: "PRIVATE" | "LINK" | "PUBLIC", shareToken: string | null = null) => ({ id: "t1", visibility, shareToken });

describe("trip access", () => {
  it("members can view and edit everything", () => {
    for (const v of ["PRIVATE", "LINK", "PUBLIC"] as const) {
      expect(canViewTrip(member, trip(v))).toBe(true);
    }
    expect(canEditTrip(member)).toBe(true);
    expect(visibleTripsWhere(member)).toEqual({});
  });
  it("anonymous visitors see public trips only, and never edit", () => {
    expect(canViewTrip(anon(), trip("PUBLIC"))).toBe(true);
    expect(canViewTrip(anon(), trip("PRIVATE"))).toBe(false);
    expect(canViewTrip(anon(), trip("LINK", "secret"))).toBe(false);
    expect(canEditTrip(anon())).toBe(false);
    expect(visibleTripsWhere(anon())).toEqual({ visibility: "PUBLIC" });
  });
  it("a matching share cookie unlocks a LINK trip, a stale one does not", () => {
    expect(canViewTrip(anon([["t1", "secret"]]), trip("LINK", "secret"))).toBe(true);
    expect(canViewTrip(anon([["t1", "old"]]), trip("LINK", "secret"))).toBe(false);
    expect(canViewTrip(anon([["t2", "secret"]]), trip("LINK", "secret"))).toBe(false);
    // Switching the trip back to PRIVATE revokes cookie access even if the token column lingers
    expect(canViewTrip(anon([["t1", "secret"]]), trip("PRIVATE", "secret"))).toBe(false);
  });
});
