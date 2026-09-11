import "dotenv/config";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { storage } from "../src/lib/storage";
import { stopBoss } from "../src/lib/jobs/boss";

/**
 * Local performance fixture: a trip with 3,000 READY photos that all share one pair of renditions, spread over two
 * weeks, so the gallery and timeline can be timed against a realistic row count without 3,000 real files.
 * Usage: pnpm tsx scripts/seed-perf.ts [count]
 */
async function main() {
  const count = Number(process.argv[2] ?? 3000);
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const admin = await db.user.upsert({ where: { email: adminEmail }, update: {}, create: { email: adminEmail, name: "Admin", role: "ADMIN" } });
  const trip = await db.trip.upsert({ where: { slug: "perf-3000" }, update: {}, create: { slug: "perf-3000", title: "Performance trip", startDate: new Date("2025-07-01"), endDate: new Date("2025-07-14"), timezone: "UTC", createdById: admin.id } });
  await db.photo.deleteMany({ where: { tripId: trip.id } });
  const store = storage();
  const fixtures = path.join(process.cwd(), "tests/fixtures");
  await mkdir(store.localPath!("photos/perf"), { recursive: true });
  // One real JPEG stands in for every original; the renditions are the JPEG too (size is irrelevant to the timing).
  for (const name of ["thumb.jpg", "medium.jpg"]) await copyFile(path.join(fixtures, "photo-no-exif.jpg"), store.localPath!(`photos/perf/${name}`));
  const start = Date.UTC(2025, 6, 1, 8);
  const rows = Array.from({ length: count }, (_, i) => ({
    uploaderId: admin.id,
    tripId: trip.id,
    originalName: `perf-${i}.jpg`,
    mimeType: "image/jpeg",
    storageKey: "photos/perf",
    originalPath: "photos/perf/medium.jpg",
    sizeBytes: 1,
    width: 1200,
    height: 800,
    status: "READY" as const,
    takenAt: new Date(start + Math.floor((i / count) * 14) * 86_400_000 + (i % 200) * 3 * 60_000),
    takenAtSource: "EXIF_OFFSET" as const,
    tzOffsetMin: 0,
    caption: i % 7 === 0 ? `Photo ${i}` : null,
    renditions: { thumb: { key: "photos/perf/thumb.jpg", w: 400, h: 267 }, medium: { key: "photos/perf/medium.jpg", w: 1200, h: 800 } },
  }));
  for (let i = 0; i < rows.length; i += 500) await db.photo.createMany({ data: rows.slice(i, i + 500) });
  console.log(`seeded ${count} photos on /trips/${trip.slug}`);
}

main()
  .then(async () => {
    await stopBoss();
    await db.$disconnect();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
