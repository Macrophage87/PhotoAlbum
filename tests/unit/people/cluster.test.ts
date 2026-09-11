import { describe, expect, it } from "vitest";
import { cosine, nearestCluster, normalise, updatedCentroid } from "@/lib/people/cluster";

describe("online clustering", () => {
  const a = normalise([1, 0.1, 0]);
  const b = normalise([0, 1, 0.1]);
  it("joins the nearest cluster above the threshold, else none", () => {
    const clusters = [{ id: "A", centroid: a }, { id: "B", centroid: b }];
    expect(nearestCluster(normalise([1, 0.2, 0]), clusters)?.cluster.id).toBe("A");
    expect(nearestCluster(normalise([0, 0, 1]), clusters)).toBeNull();
  });
  it("keeps centroids unit length as faces join", () => {
    const c = updatedCentroid(a, 3, normalise([1, 0, 0.3]));
    expect(Math.sqrt(c.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1);
    expect(cosine(c, a)).toBeGreaterThan(0.95);
  });
});
