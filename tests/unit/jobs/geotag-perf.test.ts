import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import type { TrackPoint } from "@/lib/tracks/types";
import { resetTestDb } from "../helpers/reset";

/**
 * A long Google visit whose filler sits at many slightly different places (copied from fixes recorded inside it),
 * weighed for every photo against a dense activity track that never comes near: the case where work kept per place
 * or per photo would pile up.
 */
describe("geotagPhotos on a dense track against a long visit", () => {
  beforeEach(resetTestDb);

  it("re-runs quickly without keeping work per visit place", async () => {
    const mom = await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } });
    const dad = await db.user.create({ data: { email: "d@example.com", role: "MEMBER" } });
    const trip = await db.trip.create({ data: { slug: "p", title: "P", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: mom.id } });
    const make = async (userId: string, source: "GPX" | "GOOGLE", pts: TrackPoint[]) => {
      const { blob, startTime, endTime } = encodePoints(pts);
      await db.track.create({ data: { tripId: trip.id, uploaderId: userId, source, name: source, startTime, endTime, pointCount: pts.length, minLat: 43, maxLat: 45, minLng: -69, maxLng: -67, simplified: [], pointsBlob: new Uint8Array(blob) } });
    };
    const start = Date.parse("2025-08-12T06:00:00Z");
    // Sixteen hours of visit filler, every point a slightly different place, 4 km east of Dad's line.
    await make(mom.id, "GOOGLE", Array.from({ length: 193 }, (_, i) => ({ t: start + i * 5 * 60_000, lat: 44 + i * 1e-5, lng: -68.05 + (i % 7) * 1e-5, filled: "visit" as const })));
    // Six hours of 1 Hz GPX that stays over 3 km from the visit's place.
    const dadStart = start + 3_600_000;
    await make(dad.id, "GPX", Array.from({ length: 6 * 3600 + 1 }, (_, i) => ({ t: dadStart + i * 1000, lat: 44 + 0.02 * Math.sin(i / 3000), lng: -68 })));
    await db.photo.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({ tripId: trip.id, uploaderId: mom.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, takenAt: new Date(dadStart + 60_000 + i * 21_000), takenAtSource: "EXIF_OFFSET" as const })),
    });
    expect((await geotagPhotos({ tripId: trip.id })).updated).toBe(1000);
    const t = performance.now();
    expect((await geotagPhotos({ tripId: trip.id })).updated).toBe(0);
    // Generous for a shared test machine; it runs in well under a tenth of this.
    expect(performance.now() - t).toBeLessThan(2_000);
  }, 120_000);
});
