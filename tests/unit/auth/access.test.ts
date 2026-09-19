import { describe, expect, it } from "vitest";
import { canContribute, canViewActivity, canViewCollection, canViewMedia, canViewTrip, isPubliclyViewable, visibleMediaWhere, visibleTripsWhere } from "@/lib/auth/access";
import type { Viewer } from "@/lib/auth/viewer";

const member: Viewer = { kind: "user", user: { id: "u1", email: "a@b.c", name: null, role: "MEMBER" }, shareTokens: new Map() };
const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });
const trip = (visibility: "PRIVATE" | "LINK" | "PUBLIC", shareToken: string | null = null) => ({ id: "t1", visibility, shareToken });

describe("trip access", () => {
  it("members can view and edit everything", () => {
    for (const v of ["PRIVATE", "LINK", "PUBLIC"] as const) {
      expect(canViewTrip(member, trip(v))).toBe(true);
    }
    expect(canContribute(member)).toBe(true);
    expect(visibleTripsWhere(member)).toEqual({});
  });
  it("anonymous visitors see public trips only, and never edit", () => {
    expect(canViewTrip(anon(), trip("PUBLIC"))).toBe(true);
    expect(canViewTrip(anon(), trip("PRIVATE"))).toBe(false);
    expect(canViewTrip(anon(), trip("LINK", "secret"))).toBe(false);
    expect(canContribute(anon())).toBe(false);
    expect(visibleTripsWhere(anon())).toEqual({ visibility: "PUBLIC" });
  });
  it("a matching share cookie unlocks a LINK trip, a stale one does not", () => {
    expect(canViewTrip(anon([["trip_t1", "secret"]]), trip("LINK", "secret"))).toBe(true);
    expect(canViewTrip(anon([["trip_t1", "old"]]), trip("LINK", "secret"))).toBe(false);
    expect(canViewTrip(anon([["trip_t2", "secret"]]), trip("LINK", "secret"))).toBe(false);
    // Switching the trip back to PRIVATE revokes cookie access even if the token column lingers
    expect(canViewTrip(anon([["trip_t1", "secret"]]), trip("PRIVATE", "secret"))).toBe(false);
  });
});

describe("an activity shared by its own link", () => {
  const walk = (shareToken: string | null) => ({ id: "a1", shareToken });

  it("is members-only until a link is made, and then only for whoever holds that link", () => {
    expect(canViewActivity(member, walk(null))).toBe(true);
    expect(canViewActivity(anon(), walk(null))).toBe(false);
    // A link exists but this visitor has not been sent it.
    expect(canViewActivity(anon(), walk("secret"))).toBe(false);
    expect(canViewActivity(anon([["activity_a1", "secret"]]), walk("secret"))).toBe(true);
    // Replacing the link retires the old one at once, and somebody else's link is no help.
    expect(canViewActivity(anon([["activity_a1", "old"]]), walk("secret"))).toBe(false);
    expect(canViewActivity(anon([["activity_a2", "secret"]]), walk("secret"))).toBe(false);
  });

  it("reaches its own photographs and nothing else of a private trip", () => {
    const privateTrip = { id: "t1", visibility: "PRIVATE" as const, shareToken: null };
    const held = anon([["activity_a1", "secret"]]);
    const onTheWalk = { trip: privateTrip, activity: walk("secret"), collections: [] };
    const elsewhere = { trip: privateTrip, activity: null, collections: [] };
    expect(canViewMedia(held, onTheWalk)).toBe(true);
    // The rest of the trip is exactly as private as it was.
    expect(canViewMedia(held, elsewhere)).toBe(false);
    expect(canViewMedia(anon(), onTheWalk)).toBe(false);
    // And withdrawing the link takes its photographs back with it.
    expect(canViewMedia(held, { ...onTheWalk, activity: walk(null) })).toBe(false);
  });

  it("does not make anything public: a link is not the open web", () => {
    expect(isPubliclyViewable({ trip: { id: "t1", visibility: "PRIVATE", shareToken: null }, activity: { id: "a1", shareToken: "secret" }, collections: [] })).toBe(false);
  });

  it("stops at the trash, like every other way in", () => {
    const held = anon([["activity_a1", "secret"]]);
    expect(canViewMedia(held, { trip: null, activity: walk("secret"), collections: [], trashedAt: new Date() })).toBe(false);
  });
});

describe("media access is the union of its containers", () => {
  const priv = { id: "t1", visibility: "PRIVATE" as const, shareToken: null };
  const pub = { id: "c1", visibility: "PUBLIC" as const, shareToken: null };
  const link = { id: "c2", visibility: "LINK" as const, shareToken: "tok" };
  it("a private-trip photo in a public collection is visible to anyone", () => {
    expect(canViewMedia(anon(), { trip: priv, collections: [pub] })).toBe(true);
    expect(isPubliclyViewable({ trip: priv, collections: [pub] })).toBe(true);
  });
  it("a private-trip photo in a private collection is members-only", () => {
    expect(canViewMedia(anon(), { trip: priv, collections: [{ ...pub, visibility: "PRIVATE" }] })).toBe(false);
    expect(canViewMedia(member, { trip: priv, collections: [] })).toBe(true);
  });
  it("media in no container is members-only", () => {
    expect(canViewMedia(anon(), { trip: null, collections: [] })).toBe(false);
    expect(isPubliclyViewable({ trip: null, collections: [] })).toBe(false);
  });
  it("a collection share cookie unlocks its items, keyed by kind", () => {
    expect(canViewCollection(anon([["collection_c2", "tok"]]), link)).toBe(true);
    expect(canViewMedia(anon([["collection_c2", "tok"]]), { trip: priv, collections: [link] })).toBe(true);
    expect(canViewMedia(anon([["trip_c2", "tok"]]), { trip: priv, collections: [link] })).toBe(false);
    expect(isPubliclyViewable({ trip: priv, collections: [link] })).toBe(false);
  });
  it("the global media filter admits only public containers for anonymous visitors, and nothing in the trash for anyone", () => {
    expect(visibleMediaWhere(member)).toEqual({ trashedAt: null });
    expect(visibleMediaWhere(anon([["collection_c2", "tok"]]))).toEqual({ trashedAt: null, OR: [{ trip: { visibility: "PUBLIC" } }, { collections: { some: { collection: { visibility: "PUBLIC" } } } }] });
  });
});
