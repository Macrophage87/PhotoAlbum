import { describe, expect, it } from "vitest";
import { shortenLine } from "@/lib/tracks/simplify";
import { townWithSpur } from "../helpers/lines";

describe("shortening a line for a small drawing", () => {
  it("keeps a one-vertex spur that taking every nth point would drop", () => {
    const { line, spur } = townWithSpur();
    for (const max of [200, 300]) {
      const short = shortenLine(line, max);
      expect(short.length).toBeLessThanOrEqual(max);
      expect(short).toContainEqual(spur);
      // Both ends where they were.
      expect(short[0]).toEqual(line[0]);
      expect(short[short.length - 1]).toEqual(line[line.length - 1]);
    }
  });

  it("leaves a line that is already short enough alone", () => {
    const line: [number, number][] = [[1, 2], [3, 4], [5, 6]];
    expect(shortenLine(line, 200)).toBe(line);
  });
});
