import { describe, expect, it } from "vitest";
import { edgesWithin } from "@/lib/graph/edges";
import { orderPair } from "@/lib/graph/neighbours";

describe("graph edges", () => {
  it("returns only edges whose both endpoints are viewable, with no trace of the rest", () => {
    const edges = [
      { a: "p1", b: "p2", score: 0.9 },
      { a: "p2", b: "hidden", score: 0.95 },
      { a: "p1", b: "p3", score: 0.7 },
    ];
    expect(edgesWithin(edges, new Set(["p1", "p2", "p3"]), 0.75)).toEqual([{ a: "p1", b: "p2", score: 0.9 }]);
    expect(edgesWithin(edges, new Set(["p2", "hidden"]), 0)).toEqual([{ a: "p2", b: "hidden", score: 0.95 }]);
  });
  it("stores one row per unordered pair", () => {
    expect(orderPair("b", "a")).toEqual(["a", "b"]);
    expect(orderPair("a", "b")).toEqual(["a", "b"]);
  });
});
