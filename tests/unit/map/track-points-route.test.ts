import { beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => ({ kind: "anonymous", user: null, shareTokens: held }) }));

import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { GET } from "@/app/api/tracks/[id]/points/route";
import { resetTestDb } from "../helpers/reset";

describe("track points route", () => {
  beforeEach(resetTestDb);

  it("keeps a public trip's full track out of shared caches", async () => {
    const user = await db.user.create({ data: { email: "t@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "pub", title: "Pub", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PUBLIC" } });
    const t0 = Date.parse("2025-08-12T13:00:00Z");
    const { blob, startTime, endTime } = encodePoints([{ t: t0, lat: 44, lng: -68 }, { t: t0 + 60_000, lat: 44.001, lng: -68 }]);
    const track = await db.track.create({
      data: { tripId: trip.id, uploaderId: user.id, source: "GPX", name: "t", startTime, endTime, pointCount: 2, minLat: 44, maxLat: 44.001, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) },
    });

    const res = await GET(new Request(`https://album.example/api/tracks/${track.id}/points`), { params: Promise.resolve({ id: track.id }) });
    expect(res.status).toBe(200);
    const cache = res.headers.get("cache-control")!;
    expect(cache).toMatch(/\bprivate\b/);
    expect(cache).not.toMatch(/\bpublic\b/);

    // Opened through the trip's share link: kept by no cache at all, since the link can be withdrawn.
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "LINK", shareToken: "tok" } });
    held.set(`trip_${trip.id}`, "tok");
    const viaLink = await GET(new Request(`https://album.example/api/tracks/${track.id}/points`), { params: Promise.resolve({ id: track.id }) });
    expect(viaLink.status).toBe(200);
    expect(viaLink.headers.get("cache-control")).toBe("private, no-store");
  });
});
