import { describe, expect, it } from "vitest";
import { ageOn, isMinor, minorsCheckPasses, nameMayLeaveServer, namingOutcome } from "@/lib/people/consent";

const now = new Date("2026-09-11T00:00:00Z");
const adult = new Date("1990-05-01T00:00:00Z");
const child = new Date("2019-05-01T00:00:00Z");

describe("the minors check", () => {
  it("computes ages and minority from the birthday", () => {
    expect(ageOn(adult, now)).toBe(36);
    expect(isMinor({ birthday: child }, now)).toBe(true);
    expect(isMinor({ birthday: null }, now)).toBe(false);
  });
  it("passes only with an adult birthday or an attestation", () => {
    expect(minorsCheckPasses({ birthday: adult, adultAttestedAt: null }, now)).toBe(true);
    expect(minorsCheckPasses({ birthday: child, adultAttestedAt: null }, now)).toBe(false);
    expect(minorsCheckPasses({ birthday: null, adultAttestedAt: null }, now)).toBe(false);
    expect(minorsCheckPasses({ birthday: null, adultAttestedAt: now }, now)).toBe(true);
  });
});

describe("naming decision table", () => {
  const base = { byAdmin: true, wantIndexing: true, parentInstruction: false, birthday: adult, attest: false, isChildFlag: false };
  it("admin, adult birthday, wants indexing: on, templates kept", () => {
    expect(namingOutcome(base, now)).toEqual({ faceIndexing: true, nullTemplates: false, pendingDecision: false, attested: false });
  });
  it("admin, no birthday, no attestation: off and nulled", () => {
    expect(namingOutcome({ ...base, birthday: null }, now)).toMatchObject({ faceIndexing: false, nullTemplates: true });
  });
  it("admin, no birthday, attestation: on and attested", () => {
    expect(namingOutcome({ ...base, birthday: null, attest: true }, now)).toEqual({ faceIndexing: true, nullTemplates: false, pendingDecision: false, attested: true });
  });
  it("admin, minor without a parent instruction: off and nulled; with one: on", () => {
    expect(namingOutcome({ ...base, birthday: child }, now)).toMatchObject({ faceIndexing: false, nullTemplates: true });
    expect(namingOutcome({ ...base, birthday: child, parentInstruction: true }, now)).toMatchObject({ faceIndexing: true, nullTemplates: false });
  });
  it("admin declines: off and nulled even for an adult", () => {
    expect(namingOutcome({ ...base, wantIndexing: false }, now)).toMatchObject({ faceIndexing: false, nullTemplates: true });
  });
  it("member naming: off, kept pending; child flag nulls at once", () => {
    expect(namingOutcome({ ...base, byAdmin: false }, now)).toEqual({ faceIndexing: false, nullTemplates: false, pendingDecision: true, attested: false });
    expect(namingOutcome({ ...base, byAdmin: false, isChildFlag: true }, now)).toEqual({ faceIndexing: false, nullTemplates: true, pendingDecision: false, attested: false });
  });
});

describe("names to the helper", () => {
  it("only for indexed adults", () => {
    expect(nameMayLeaveServer({ birthday: adult, adultAttestedAt: null, faceIndexing: true }, now)).toBe(true);
    expect(nameMayLeaveServer({ birthday: adult, adultAttestedAt: null, faceIndexing: false }, now)).toBe(false);
    expect(nameMayLeaveServer({ birthday: child, adultAttestedAt: null, faceIndexing: true }, now)).toBe(false);
  });
});
