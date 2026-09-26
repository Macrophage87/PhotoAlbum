import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const viewer = vi.hoisted(() => ({ kind: "user" as "user" | "anonymous" }));
vi.mock("@/lib/auth/viewer", () => {
  const current = () => (viewer.kind === "user" ? { kind: "user", user: { id: "u", email: "r@example.com", name: null, role: "ADMIN" }, shareTokens: new Map() } : { kind: "anonymous", user: null, shareTokens: new Map() });
  return {
    getViewer: async () => current(),
    requireUserOrThrow: async () => {
      const v = current();
      if (v.kind !== "user") throw new Error("Unauthorized");
      return v.user;
    },
  };
});

import { db } from "@/lib/db";
import { GET as unassigned } from "@/app/api/photos/unassigned/route";
import { GET as tripPhotos } from "@/app/api/trips/[slug]/photos/route";
import { moreTripCandidates } from "@/app/trips/[slug]/add-actions";
import { searchParamsObject } from "@/lib/search-params";
import { resetTestDb } from "../helpers/reset";

describe("reading a query string the way a page reads its address", () => {
  it("keeps every value of a repeated key and a single value as it is", () => {
    expect(searchParamsObject(new URLSearchParams("q=dog&person=a&person=b&kind="))).toEqual({ q: "dog", person: ["a", "b"], kind: "" });
  });
});

describe("the next page of a gallery asked for two people", () => {
  let both: string, onlyA: string, onlyB: string, a: string, b: string;
  beforeEach(async () => {
    await resetTestDb();
    viewer.kind = "user";
    const user = await db.user.create({ data: { email: "r@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "r", title: "R", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    await db.trip.create({ data: { slug: "elsewhere", title: "Elsewhere", startDate: new Date("2025-09-10"), endDate: new Date("2025-09-16"), createdById: user.id } });
    const photo = async (tripId: string | null) => (await db.photo.create({ data: { tripId, uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    a = (await db.person.create({ data: { name: "Ada", createdById: user.id } })).id;
    b = (await db.person.create({ data: { name: "Bo", createdById: user.id } })).id;
    const face = (photoId: string, personId: string) => db.face.create({ data: { photoId, personId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0.9 } });
    // The same three on no trip and on the trip: one with both of them, one with each.
    for (const tripId of [null, trip.id]) {
      const [x, y, z] = [await photo(tripId), await photo(tripId), await photo(tripId)];
      await face(x, a); await face(x, b); await face(y, a); await face(z, b);
      if (!tripId) [both, onlyA, onlyB] = [x, y, z];
    }
  });

  const ids = async (r: Response) => ((await r.json()) as { photos: { id: string }[] }).photos.map((p) => p.id);

  it("keeps photos without a trip to members", async () => {
    viewer.kind = "anonymous";
    const r = await unassigned(new NextRequest(`http://album.test/api/photos/unassigned?person=${a}`));
    expect(r.status).toBe(401);
  });

  it("means the photographs they are both in, on photos without a trip", async () => {
    expect(await ids(await unassigned(new NextRequest(`http://album.test/api/photos/unassigned?person=${a}&person=${b}`)))).toEqual([both]);
    expect((await ids(await unassigned(new NextRequest(`http://album.test/api/photos/unassigned?person=${a}`)))).sort()).toEqual([both, onlyA].sort());
    expect(onlyB).toBeTruthy();
  });

  it("means the same on a trip's gallery and in the picker", async () => {
    expect(await ids(await tripPhotos(new NextRequest(`http://album.test/api/trips/r/photos?person=${a}&person=${b}`), { params: Promise.resolve({ slug: "r" }) }))).toHaveLength(1);
    const picked = await moreTripCandidates("elsewhere", `person=${a}&person=${b}`, "");
    // Both copies of "both of them" and nothing else: one on no trip, one on the other trip.
    expect(picked.photos).toHaveLength(2);
    expect(picked.photos.map((p) => p.id)).toContain(both);
  });
});
