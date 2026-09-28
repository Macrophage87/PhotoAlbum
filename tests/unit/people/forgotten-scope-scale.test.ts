import { expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgottenScope, loadTombstone, rememberForgotten } from "@/lib/people/tombstone";

/**
 * A description of a whole trip asks which one-word forgotten names count there, two or three times. With 20
 * forgotten names over 1,000 photographs each, and a trip of 20,000 photographs none of them on, it answered in
 * seconds when the rows' arrays were compared in SQL; it is a few map reads now.
 */
it("finds which forgotten names count in a trip of 20,000 photographs quickly", async () => {
  await resetTestDb();
  const admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date(), endDate: new Date(), createdById: admin } });
  const theirs = await db.trip.create({ data: { slug: "o", title: "O", startDate: new Date(), endDate: new Date(), createdById: admin } });
  const photos = (prefix: string, tripId: string) => Array.from({ length: 20_000 }, (_, i) => ({ id: `${prefix}${String(i).padStart(7, "0")}xxxxxxxxxxxxxxx`, uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: `${prefix}${i}`, originalPath: "o", sizeBytes: 1, status: "READY" as const, tripId }));
  const inTrip = photos("p", trip.id);
  const forgottenOn = photos("q", theirs.id);
  for (let i = 0; i < 20_000; i += 5_000) await db.photo.createMany({ data: [...inTrip.slice(i, i + 5_000), ...forgottenOn.slice(i, i + 5_000)] });
  for (let n = 0; n < 20; n++) {
    const ids = forgottenOn.slice(n * 1_000, n * 1_000 + 1_000).map((p) => p.id);
    await rememberForgotten([{ form: `Zyx${n}abc`, capitalizedOnly: true }], { photoIds: ids, taggedPhotoIds: ids.slice(0, 200), containerIds: [`trip:x${n}`] });
  }
  const ts = await loadTombstone();
  const whole = () => forgottenScope({ containers: [{ kind: "trip", id: trip.id }] }, ts);
  const t0 = performance.now();
  expect((await whole()).rows.size).toBe(0);
  const first = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 3; i++) await whole();
  const then = (performance.now() - t1) / 3;
  // The first hashes the trip's 20,000 photographs; the ones after reuse them, as a description's second and third do.
  expect({ first: first < 1_500, then: then < 200 }).toEqual({ first: true, then: true });
  // And it still finds them where they are.
  expect((await forgottenScope({ containers: [{ kind: "trip", id: theirs.id }] }, ts)).rows.size).toBe(20);
}, 120_000);
