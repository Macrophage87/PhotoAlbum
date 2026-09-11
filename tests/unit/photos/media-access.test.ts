import { describe, expect, it } from "vitest";
import { mediaBytesAllowed, mediaCacheControl } from "@/lib/photos/access";
import type { Viewer } from "@/lib/auth/viewer";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const linkTrip = { id: "t1", visibility: "LINK" as const, shareToken: "tok" };
const linkCol = { id: "c1", visibility: "LINK" as const, shareToken: "ctok" };

describe("media bytes with a share token in the query", () => {
  it("accepts the token of a LINK container holding the item, for the right kind", () => {
    expect(mediaBytesAllowed(anon, { trip: linkTrip, collections: [] }, { token: "tok", kind: "trip" })).toBe(true);
    expect(mediaBytesAllowed(anon, { trip: linkTrip, collections: [] }, { token: "tok", kind: null })).toBe(true);
    expect(mediaBytesAllowed(anon, { trip: null, collections: [linkCol] }, { token: "ctok", kind: "collection" })).toBe(true);
  });
  it("rejects a token of the wrong kind, a stale token, or a container that does not hold the item", () => {
    expect(mediaBytesAllowed(anon, { trip: null, collections: [linkCol] }, { token: "ctok", kind: "trip" })).toBe(false);
    expect(mediaBytesAllowed(anon, { trip: linkTrip, collections: [] }, { token: "old", kind: "trip" })).toBe(false);
    expect(mediaBytesAllowed(anon, { trip: { ...linkTrip, visibility: "PRIVATE" }, collections: [] }, { token: "tok", kind: "trip" })).toBe(false);
  });
});

describe("cache headers", () => {
  it("lets shared caches keep only publicly viewable items", () => {
    expect(mediaCacheControl({ trip: { id: "t", visibility: "PUBLIC", shareToken: null }, collections: [] }, true)).toMatch(/^public/);
    expect(mediaCacheControl({ trip: linkTrip, collections: [] }, true)).toMatch(/^private/);
    expect(mediaCacheControl({ trip: linkTrip, collections: [] }, true)).not.toContain("immutable");
    expect(mediaCacheControl({ trip: null, collections: [] }, false)).toContain("must-revalidate");
  });
});
