import { describe, expect, it } from "vitest";
import { readableContainerDescription, readableDescription, readablePlaceGuess, readableTitle, withReadableDescription } from "@/lib/photos/readable-text";
import { annotationCustomId, mentionsAnyName, mentionsAnyTitle, parseAnnotationCustomId, requestCarriesMembersOnly } from "@/lib/annotation/members-only";
import { titlesAfter } from "@/lib/annotation/apply";
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

  it("names the helper's guess at a place only where it came from nothing members-only", () => {
    const guess = { placeEstimateName: "Towson, Maryland", placeEstimateNote: "the notes say Grandma's house" };
    expect(readablePlaceGuess({ ...guess, placeEstimateMembersOnly: true }, true)).toEqual({ name: "Towson, Maryland", note: "the notes say Grandma's house" });
    expect(readablePlaceGuess({ ...guess, placeEstimateMembersOnly: true }, false)).toEqual({ name: null, note: null });
    expect(readablePlaceGuess({ ...guess, placeEstimateMembersOnly: false }, false)).toEqual({ name: "Towson, Maryland", note: "the notes say Grandma's house" });
    expect(readablePlaceGuess(guess, false)).toEqual({ name: null, note: null });
  });
});

describe("spotting a name the album knows", () => {
  it("matches the whole name, and each word of it that can only be a name", () => {
    expect(mentionsAnyName("Ada and Ben on the porch", ["Ada Lovelace"])).toBe(true);
    // A surname on its own is a mention too: "the Lovelace house" is theirs.
    expect(mentionsAnyName("The Lovelace house", ["Ada Lovelace"])).toBe(true);
    expect(mentionsAnyName("Coffee with grandma jo", ["Grandma Jo"])).toBe(true);
    // "Grandma" is everybody's, and "Jo" on its own too short to tell from a word.
    expect(mentionsAnyName("Coffee with Grandma", ["Grandma Jo"])).toBe(false);
    expect(mentionsAnyName("Jo and the dog", ["Grandma Jo"])).toBe(false);
    expect(mentionsAnyName("Bob at the grill", ["Uncle Bob"])).toBe(true);
    expect(mentionsAnyName("Uncle at the grill", ["Uncle Bob"])).toBe(false);
    expect(mentionsAnyName("Ada reads", ["Aunt Ada"])).toBe(true);
    expect(mentionsAnyName("Tea at the Smiths'", ["Mrs. Smith"])).toBe(true);
    expect(mentionsAnyName("Mrs. Jones waves", ["Mrs. Smith"])).toBe(false);
    // Two letters in it: only the whole name is safe.
    expect(mentionsAnyName("Li Wei by the river", ["Li Wei"])).toBe(true);
    expect(mentionsAnyName("Wei by the river", ["Li Wei"])).toBe(false);
    expect(mentionsAnyName("Lunch with Pat O'Brien", ["Pat O'Brien"])).toBe(true);
    // "van" begins a name without being one.
    expect(mentionsAnyName("Loading the van", ["van Gogh"])).toBe(false);
    expect(mentionsAnyName("A van Gogh print", ["van Gogh"])).toBe(true);
  });

  it("matches a name that is also an everyday word only as a name is written", () => {
    expect(mentionsAnyName("Sand digging a hole", ["Sand"])).toBe(true);
    expect(mentionsAnyName("Castles in the sand", ["Sand"])).toBe(false);
    expect(mentionsAnyName("Rose Walker on the porch", ["Rose Walker"])).toBe(true);
    expect(mentionsAnyName("rose walker", ["Rose Walker"])).toBe(true);
    expect(mentionsAnyName("Rose by the gate", ["Rose Walker"])).toBe(true);
    expect(mentionsAnyName("A rose bush by the gate", ["Rose Walker"])).toBe(false);
    expect(mentionsAnyName("The Hens scratching in the yard", ["The Hens"])).toBe(true);
    expect(mentionsAnyName("the hens scratching in the yard", ["The Hens"])).toBe(false);
  });

  it("matches a name in Chinese, Japanese or Korean characters exactly", () => {
    expect(mentionsAnyName("王伟 at the beach", ["王伟"])).toBe(true);
    expect(mentionsAnyName("王伟和李娜在海边", ["王伟"])).toBe(true);
    // One character is a name only standing on its own, not inside a longer word.
    expect(mentionsAnyName("伟 at the beach", ["伟"])).toBe(true);
    expect(mentionsAnyName("伟大的一天", ["伟"])).toBe(false);
  });

  it("reads possessives, plurals and accents, and only whole words", () => {
    expect(mentionsAnyName("Ada's first swim", ["Ada"])).toBe(true);
    expect(mentionsAnyName("Ada’s first swim", ["Ada"])).toBe(true);
    expect(mentionsAnyName("Dinner at the Smiths", ["Smith"])).toBe(true);
    expect(mentionsAnyName("EMMAS BIRTHDAY", ["Emma"])).toBe(true);
    expect(mentionsAnyName("ADA'S CAKE", ["Ada"])).toBe(true);
    expect(mentionsAnyName("Jose on the dock", ["José"])).toBe(true);
    expect(mentionsAnyName("José on the dock", ["Jose"])).toBe(true);
    expect(mentionsAnyName("A canada goose", ["Ada"])).toBe(false);
    expect(mentionsAnyName("Anything at all", [])).toBe(false);
    // Nothing in a name is taken as a pattern.
    expect(mentionsAnyName("a b c", ["(.*)"])).toBe(false);
  });

  it("spots a word of a private title, but not one every title has", () => {
    expect(mentionsAnyTitle("Waiting at Hopkins", ["Hopkins weekend"])).toBe(true);
    expect(mentionsAnyTitle("A long weekend", ["Hopkins weekend"])).toBe(false);
    expect(mentionsAnyTitle("Summer 2019", ["Lake House 2019"])).toBe(false);
    // Any other word of four letters or more counts, common or not: a false alarm only keeps a sentence in the family.
    expect(mentionsAnyTitle("At the lake", ["Lake House 2019"])).toBe(true);
  });
});

describe("recording what a request to the helper carried", () => {
  it("counts notes and confirmed names, and rides on a batch request's id", () => {
    expect(requestCarriesMembersOnly({ context: "  " }, [])).toBe(false);
    expect(requestCarriesMembersOnly({ context: "the key is under the mat" }, [])).toBe(true);
    expect(requestCarriesMembersOnly({ context: null }, ["Ada"])).toBe(true);
    expect(parseAnnotationCustomId(annotationCustomId("cabc123", true))).toEqual({ photoId: "cabc123", sent: true });
    expect(parseAnnotationCustomId(annotationCustomId("cabc123", false))).toEqual({ photoId: "cabc123", sent: null });
  });
});

describe("where the helper's title goes", () => {
  it("fills an empty title with a public one, and keeps a members-only one aside", () => {
    expect(titlesAfter({ title: null, membersTitle: null, previousAiTitle: null }, "Mail boat lunch", false)).toEqual({ title: "Mail boat lunch", membersTitle: null, titleByHelper: true });
    expect(titlesAfter({ title: null, membersTitle: null, previousAiTitle: null }, "Ada on the boat", true)).toEqual({ title: null, membersTitle: "Ada on the boat", titleByHelper: null });
    // The family's own title is never touched.
    expect(titlesAfter({ title: "Our day", membersTitle: null, previousAiTitle: null }, "Ada on the boat", true)).toEqual({ title: "Our day", membersTitle: "Ada on the boat", titleByHelper: null });
  });

  it("takes an older helper title off a members-only item, and never one the family typed", () => {
    // Described from notes as "Ada's birthday cake", then described again as "Cake table": the old title was the helper's.
    expect(titlesAfter({ title: "Ada's birthday cake", membersTitle: null, previousAiTitle: "Ada's birthday cake", titleByHelper: true }, "Cake table", true)).toEqual({ title: null, membersTitle: "Cake table", titleByHelper: null });
    expect(titlesAfter({ title: "Ada's birthday cake", membersTitle: null, previousAiTitle: "Cake table", titleByHelper: null, pastTitles: ["Ada's birthday cake"] }, "Cake table", true)).toMatchObject({ title: null });
    // From before the album kept track and none of the helper's: the family's, whatever it names.
    expect(titlesAfter({ title: "Ada's birthday cake", membersTitle: null, previousAiTitle: "Cake table", titleByHelper: null, pastTitles: [] }, "Cake table", true)).toEqual({ title: "Ada's birthday cake", membersTitle: "Cake table", titleByHelper: null });
    // Typed by a member since the album kept track: theirs to publish, names and all.
    expect(titlesAfter({ title: "Ada's birthday cake", membersTitle: null, previousAiTitle: "Cake table", titleByHelper: false }, "Cake table", true)).toMatchObject({ title: "Ada's birthday cake" });
  });

  it("replaces only the helper's own last title, never one moved aside because it named somebody", () => {
    // Described again without names: the old members-only title goes and the new one is anybody's.
    expect(titlesAfter({ title: null, membersTitle: "Ada on the boat", previousAiTitle: "Ada on the boat" }, "Boat day", false)).toEqual({ title: "Boat day", membersTitle: null, titleByHelper: true });
    // A title of the family's that was moved aside stays, and keeps the public one from taking its place.
    expect(titlesAfter({ title: null, membersTitle: "Nana's 80th", previousAiTitle: "Boat day" }, "Boat day", false)).toEqual({ title: null, membersTitle: "Nana's 80th", titleByHelper: null });
    expect(titlesAfter({ title: null, membersTitle: "Nana's 80th", previousAiTitle: "Boat day" }, "Ada on the boat", true)).toEqual({ title: null, membersTitle: "Nana's 80th", titleByHelper: null });
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
