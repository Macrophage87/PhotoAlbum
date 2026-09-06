import "dotenv/config";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { storage } from "../src/lib/storage";
import { processPhoto } from "../src/lib/jobs/handlers/process-photo";
import { importTrackFile } from "../src/lib/tracks/import";
import { geotagPhotos } from "../src/lib/jobs/handlers/geotag-photos";
import { stopBoss } from "../src/lib/jobs/boss";

/**
 * Demo content for a fresh install: the admin account, a lighthouse-themed Maine trip, a hike
 * imported from a GPX file (activity + stats) and three sample photos, one of which is positioned
 * from the track. Safe to re-run.
 */
async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const admin = await db.user.upsert({ where: { email: adminEmail }, update: { role: "ADMIN" }, create: { email: adminEmail, name: "Admin", role: "ADMIN" } });
  console.log(`admin: ${admin.email}`);

  const trip = await db.trip.upsert({
    where: { slug: "acadia-maine" },
    update: {},
    create: {
      slug: "acadia-maine",
      title: "Acadia, Maine",
      description: "A week of lighthouses, lobster rolls and carriage-road rides on Mount Desert Island.",
      startDate: new Date("2025-08-10"),
      endDate: new Date("2025-08-16"),
      timezone: "America/New_York",
      themeKey: "lighthouse",
      createdById: admin.id,
    },
  });
  console.log(`trip: ${trip.slug}`);

  const fixtures = path.join(process.cwd(), "tests/fixtures");
  const haveFixtures = await stat(fixtures).then(() => true).catch(() => false);
  if (!haveFixtures) {
    console.log("fixtures not found; skipping sample photos and track");
    return;
  }
  const store = storage();

  if ((await db.track.count({ where: { tripId: trip.id } })) === 0) {
    const importKey = "imports/seed-ocean-path.gpx";
    await mkdir(path.dirname(store.localPath!(importKey)), { recursive: true });
    await copyFile(path.join(fixtures, "sample-hr.gpx"), store.localPath!(importKey));
    const summary = await importTrackFile({ importKey, tripId: trip.id, userId: admin.id, sourceHint: "gpx", originalName: "ocean-path.gpx" });
    console.log(`track: ${summary.tracks.map((t) => t.name).join(", ")}`);
  }

  if ((await db.photo.count({ where: { tripId: trip.id } })) === 0) {
    for (const [file, caption] of [
      ["photo-with-gps.jpg", "Otter Cliff from the Ocean Path"],
      ["photo-no-gps.jpg", "Morning at Jordan Pond"],
      ["photo-no-exif.jpg", "Lobster roll, obviously"],
    ] as const) {
      const photo = await db.photo.create({
        data: { uploaderId: admin.id, tripId: trip.id, originalName: file, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0, caption },
      });
      const key = `photos/${photo.id}`;
      const originalPath = `${key}/original.jpg`;
      await mkdir(path.dirname(store.localPath!(originalPath)), { recursive: true });
      await copyFile(path.join(fixtures, file), store.localPath!(originalPath));
      const size = (await stat(store.localPath!(originalPath))).size;
      await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath, sizeBytes: size } });
      await processPhoto({ photoId: photo.id, tripId: trip.id });
    }
    const { updated } = await geotagPhotos({ tripId: trip.id });
    console.log(`photos: 3 processed, ${updated} positioned from the track`);
  }
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
