import { describe, expect, it } from "vitest";
import { parseScope } from "@/lib/graph/query";

const of = (qs: string) => parseScope(new URLSearchParams(qs));

describe("what the graph is asked to draw", () => {
  it("reads a link that says what it means", () => {
    expect(of("trip=acadia")).toEqual({ kind: "trip", slug: "acadia" });
    expect(of("collection=best-of-2025")).toEqual({ kind: "collection", slug: "best-of-2025" });
    expect(of("person=abc123")).toEqual({ kind: "person", id: "abc123" });
    expect(of("")).toEqual({ kind: "all" });
  });

  it("reads the picker, which sends the kind and the value together under one name", () => {
    // A single <select> can only send one name, so it carries both. Reading only the plain spelling left the
    // picker doing nothing: whatever was chosen, the page went on drawing the whole library.
    expect(of("scope=trip%3Dacadia")).toEqual({ kind: "trip", slug: "acadia" });
    expect(of("scope=collection%3Dbest-of-2025")).toEqual({ kind: "collection", slug: "best-of-2025" });
    expect(of("scope=person%3Dabc123")).toEqual({ kind: "person", id: "abc123" });
  });

  it("takes the empty choice, and anything it does not recognize, as the whole library", () => {
    expect(of("scope=")).toEqual({ kind: "all" });
    expect(of("scope=nonsense%3Dvalue")).toEqual({ kind: "all" });
    expect(of("scope=trip%3D")).toEqual({ kind: "all" });
  });

  it("keeps a slug that has an equals sign in it whole", () => {
    expect(of("scope=trip%3Da%3Db")).toEqual({ kind: "trip", slug: "a=b" });
  });
});
