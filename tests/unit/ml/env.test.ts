import { describe, expect, it } from "vitest";
import { z } from "zod";

// Mirrors the refinement in src/lib/env.ts: an ML_URL without a token must fail closed.
const schema = z.object({ ML_URL: z.string().url().optional(), ML_TOKEN: z.string().optional() }).refine((e) => !e.ML_URL || Boolean(e.ML_TOKEN), { path: ["ML_TOKEN"] });

describe("ML configuration", () => {
  it("requires ML_TOKEN whenever ML_URL is set", () => {
    expect(schema.safeParse({ ML_URL: "http://ml:8000" }).success).toBe(false);
    expect(schema.safeParse({ ML_URL: "http://ml:8000", ML_TOKEN: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });
});
