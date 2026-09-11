import { afterEach, describe, expect, it, vi } from "vitest";
import { vectorLiteral } from "@/lib/ml/client";

describe("ml client helpers", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("formats vectors as pgvector literals", () => {
    expect(vectorLiteral([0.5, -1, 1e-9])).toBe("[0.500000,-1.000000,0.000000]");
    expect(vectorLiteral([Number.NaN])).toBe("[0]");
  });
});
