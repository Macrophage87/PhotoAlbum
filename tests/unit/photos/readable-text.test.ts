import { describe, expect, it } from "vitest";
import { descriptionStaysMembersOnly, readableContainerDescription, readableDescription, readableTitle, withReadableDescription } from "@/lib/photos/readable-text";
import { mentionsAnyName } from "@/lib/annotation/members-only";
import { mediaTripNameable } from "@/lib/photos/access";
import type { Viewer } from "@/lib/auth/viewer";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const member: Viewer = { kind: "user", user: { id: "u", email: "u@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };

/**
 * One rule for what of a photograph's words a viewer may read: members everything, anybody else the family's own
 * caption and title and the helper's text only where it was written from nothing members-only.
 */
describe("what a viewer may read of a photograph", () => {
  const named = { title: null, membersTitle: "Ada and Ben on the porch", caption: null, context: "key under the mat", annotation: { description: "Ada and Ben with their coffee." }, annotationMembersOnly: true };
  const plain = { title: "Porch morning", membersTitle: null, caption: null, context: null, annotation: { description: "Two people with coffee on a porch." }, annotationMembersOnly: false };

  it("gives members the helper's title that names somebody, and nobody else", () => {
    expect(readableTitle(named, true)).toBe("Ada and Ben on the porch");
    expect(readableTitle(named, false)).toBeNull();
    // A title of the family's own wins for everybody.
    expect(readableTitle({ ...named, title: "Porch" }, true)).toBe("Porch");
    expect(readableTitle({ ...named, title: "Porch" }, false)).toBe("Porch");
  });

  it("keeps the helper's description from strangers when it was written from names or notes, and the notes always", () => {
    expect(readableDescription(named, true)).toBe("Ada and Ben with their coffee.");
    expect(readableDescription(named, false)).toBeNull();
    expect(readableDescription(plain, false)).toBe("Two people with coffee on a porch.");
    // No description from the helper: members read the notes in its place, strangers read nothing.
    expect(readableDescription({ ...named, annotation: null }, true)).toBe("key under the mat");
    expect(readableDescription({ ...plain, annotation: null, context: "key under the mat" }, false)).toBeNull();
    // A caller that never asked whether the text is members-only is treated as if it were.
    expect(readableDescription({ title: null, caption: null, annotation: { description: "Ada." } }, false)).toBeNull();
  });

  it("applies the same rule to a trip's, a collection's or an activity's description", () => {
    const trip = { description: "A week at the lake with Ada.", descriptionMembersOnly: true };
    expect(readableContainerDescription(trip, true)).toBe(trip.description);
    expect(readableContainerDescription(trip, false)).toBeNull();
    expect(withReadableDescription({ ...trip, id: "t" }, false)).toEqual({ id: "t", description: null, descriptionMembersOnly: true });
    expect(readableContainerDescription({ ...trip, descriptionMembersOnly: false }, false)).toBe(trip.description);
  });

  it("keeps a description members-only while its words are unchanged, and hands it back to its author once rewritten", () => {
    const before = { description: "A week at the lake with Ada.", descriptionMembersOnly: true };
    expect(descriptionStaysMembersOnly(before, "  A week at the lake with Ada. ")).toBe(true);
    expect(descriptionStaysMembersOnly(before, "A week at the lake.")).toBe(false);
    expect(descriptionStaysMembersOnly({ ...before, descriptionMembersOnly: false }, before.description)).toBe(false);
  });
});

describe("spotting a name the album knows", () => {
  it("matches any word of a name, whole words only, ignoring case", () => {
    expect(mentionsAnyName("Ada and Ben on the porch", ["Ada Lovelace"])).toBe(true);
    expect(mentionsAnyName("Coffee with grandma jo", ["Grandma Jo"])).toBe(true);
    expect(mentionsAnyName("Ada's first swim", ["Ada"])).toBe(true);
    // Inside another word is not a mention.
    expect(mentionsAnyName("A canada goose", ["Ada"])).toBe(false);
    expect(mentionsAnyName("Anything at all", [])).toBe(false);
    // A name with punctuation in it is still read as its words, and nothing in it is taken as a pattern.
    expect(mentionsAnyName("Lunch with O'Brien", ["Pat O'Brien"])).toBe(true);
    expect(mentionsAnyName("a b c", ["(.*)"])).toBe(false);
  });
});

describe("naming the trip beside a photograph", () => {
  const privateTrip = { id: "t1", visibility: "PRIVATE" as const, shareToken: null };
  const linkTrip = { id: "t2", visibility: "LINK" as const, shareToken: "tok" };

  it("names a private trip to members only, whatever else let the viewer see the photograph", () => {
    expect(mediaTripNameable(member, privateTrip)).toBe(true);
    expect(mediaTripNameable(anon, privateTrip)).toBe(false);
    expect(mediaTripNameable(anon, privateTrip, { token: "ctok", kind: "collection" })).toBe(false);
    expect(mediaTripNameable(anon, null)).toBe(false);
  });

  it("names a link trip to whoever holds its own link, by cookie or in the address, and not on another container's token", () => {
    expect(mediaTripNameable({ ...anon, shareTokens: new Map([["trip_t2", "tok"]]) }, linkTrip)).toBe(true);
    expect(mediaTripNameable(anon, linkTrip, { token: "tok", kind: "trip" })).toBe(true);
    expect(mediaTripNameable(anon, linkTrip, { token: "tok", kind: "collection" })).toBe(false);
    expect(mediaTripNameable(anon, linkTrip, { token: "tok", kind: "activity" })).toBe(false);
    expect(mediaTripNameable(anon, linkTrip, { token: "old", kind: "trip" })).toBe(false);
    expect(mediaTripNameable(anon, { id: "t3", visibility: "PUBLIC", shareToken: null })).toBe(true);
  });
});
