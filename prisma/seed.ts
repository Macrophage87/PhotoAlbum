import "dotenv/config";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { storage } from "../src/lib/storage";
import { processPhoto } from "../src/lib/jobs/handlers/process-photo";
import { importTrackFile } from "../src/lib/tracks/import";
import { geotagPhotos } from "../src/lib/jobs/handlers/geotag-photos";
import { stopBoss } from "../src/lib/jobs/boss";
import { makeRenditions } from "../src/lib/images/renditions";
import { toStored } from "../src/lib/annotation/schema";
import { vectorLiteral } from "../src/lib/ml/client";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Demo content for a fresh install, all from local fixtures and with no network or API key: the admin account,
 * a lighthouse-themed Maine trip with a hike (GPX: activity + stats) and three sample photos (one positioned from
 * the track), a second trip, a collection spanning both, a short clip with pre-made renditions, a YouTube item with
 * a stored poster, two consented adults with fixture face templates, a pet, the face-detection opt-in, and
 * annotations copied from the recorded test fixture. Safe to re-run.
 */

/** A deterministic unit vector, the same shape the ML sidecar returns; stands in for a real template. */
function fixtureVector(seed: string, dim: number): number[] {
  const out: number[] = [];
  let h = createHash("sha256").update(seed).digest();
  while (out.length < dim) {
    for (let i = 0; i + 4 <= h.length && out.length < dim; i += 4) out.push((h.readUInt32LE(i) / 0xffffffff) * 2 - 1);
    h = createHash("sha256").update(h).digest();
  }
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  return out.map((x) => x / n);
}
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

  // A second trip, so the collection below spans two.
  const highlands = await db.trip.upsert({
    where: { slug: "scottish-highlands" },
    update: {},
    create: { slug: "scottish-highlands", title: "Scottish Highlands", description: "Glens, lochs and one very wet castle.", startDate: new Date("2024-06-02"), endDate: new Date("2024-06-09"), timezone: "Europe/London", themeKey: "highlands", createdById: admin.id },
  });
  if ((await db.photo.count({ where: { tripId: highlands.id } })) === 0) {
    const photo = await db.photo.create({ data: { uploaderId: admin.id, tripId: highlands.id, originalName: "photo-no-exif.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0, caption: "Eilean Donan in the rain", takenAt: new Date("2024-06-04T14:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: 60 } });
    const key = `photos/${photo.id}`;
    const originalPath = `${key}/original.jpg`;
    await mkdir(path.dirname(store.localPath!(originalPath)), { recursive: true });
    await copyFile(path.join(fixtures, "photo-no-exif.jpg"), store.localPath!(originalPath));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath, sizeBytes: (await stat(store.localPath!(originalPath))).size } });
    await processPhoto({ photoId: photo.id, tripId: highlands.id, mode: "renditions" });
    console.log("trip: scottish-highlands (1 photo)");
  }

  const maine = await db.photo.findMany({ where: { tripId: trip.id, status: "READY", kind: "PHOTO" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const scot = await db.photo.findMany({ where: { tripId: highlands.id, status: "READY" }, select: { id: true } });

  // A collection with items from both trips.
  const collection = await db.collection.upsert({
    where: { slug: "summer-favourites" },
    update: {},
    create: { slug: "summer-favourites", title: "Summer favourites", description: "The ones we keep coming back to.", themeKey: "default", createdById: admin.id },
  });
  if ((await db.collectionItem.count({ where: { collectionId: collection.id } })) === 0) {
    const picks = [...maine.slice(0, 2), ...scot];
    await db.collectionItem.createMany({ data: picks.map((p, i) => ({ collectionId: collection.id, photoId: p.id, position: i, addedById: admin.id })) });
    console.log(`collection: ${collection.slug} (${picks.length} items from two trips)`);
  }

  // A short clip with pre-generated renditions (no ffmpeg needed at seed time).
  if ((await db.photo.count({ where: { tripId: trip.id, kind: "VIDEO" } })) === 0) {
    const clip = await db.photo.create({ data: { uploaderId: admin.id, tripId: trip.id, kind: "VIDEO", originalName: "clip.mp4", mimeType: "video/mp4", storageKey: "pending", originalPath: "pending", sizeBytes: 0, caption: "Waves at Thunder Hole", takenAt: new Date("2025-08-13T15:30:00Z"), takenAtSource: "MANUAL", tzOffsetMin: -240, durationS: 2 } });
    const key = `photos/${clip.id}`;
    await mkdir(store.localPath!(`${key}/video`), { recursive: true });
    await copyFile(path.join(fixtures, "clip.mp4"), store.localPath!(`${key}/original.mp4`));
    await copyFile(path.join(fixtures, "clip.mp4"), store.localPath!(`${key}/video/720p.mp4`));
    await copyFile(path.join(fixtures, "clip-poster.jpg"), store.localPath!(`${key}/poster.jpg`));
    const { renditions, width, height } = await makeRenditions(store.localPath!(`${key}/poster.jpg`), key, (k, buf) => store.putBuffer(k, buf));
    const bytes = (await stat(store.localPath!(`${key}/video/720p.mp4`))).size;
    await db.photo.update({ where: { id: clip.id }, data: { storageKey: key, originalPath: `${key}/original.mp4`, sizeBytes: bytes, width, height, renditions, videoRenditions: { mp4: { key: `${key}/video/720p.mp4`, w: width, h: height, bytes }, poster: { key: `${key}/poster.jpg` } }, status: "READY" } });
    console.log("clip: seeded with pre-made renditions");
  }

  // A YouTube item with a stored poster (the fixture image stands in for the real thumbnail).
  if ((await db.photo.count({ where: { kind: "EXTERNAL_VIDEO" } })) === 0) {
    const yt = await db.photo.create({ data: { uploaderId: admin.id, tripId: trip.id, kind: "EXTERNAL_VIDEO", sourceKind: "YOUTUBE", provider: "YOUTUBE", externalId: "aqz-KE-bpKQ", externalUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", title: "Carriage roads by bike (sample embed)", externalStatus: "AVAILABLE", externalCheckedAt: new Date(), originalName: "youtube:aqz-KE-bpKQ", mimeType: "video/youtube", storageKey: "pending", originalPath: "pending", sizeBytes: 0, takenAt: new Date("2025-08-14T13:00:00Z"), takenAtSource: "MANUAL", tzOffsetMin: -240 } });
    const key = `photos/${yt.id}`;
    await mkdir(store.localPath!(key), { recursive: true });
    await copyFile(path.join(fixtures, "photo-no-gps.jpg"), store.localPath!(`${key}/poster.jpg`));
    await db.photo.update({ where: { id: yt.id }, data: { storageKey: key, originalPath: `${key}/poster.jpg` } });
    await processPhoto({ photoId: yt.id, tripId: trip.id, mode: "renditions" });
    console.log("youtube: seeded with a stored poster");
  }

  // Annotations copied from the recorded test fixture: what the AI helper would have written, without calling it.
  const annotation = toStored(JSON.parse(await readFile(path.join(fixtures, "annotation-response.json"), "utf8")));
  const unannotated = await db.photo.findMany({ where: { annotatedAt: null, status: "READY", kind: "PHOTO" }, select: { id: true } });
  if (unannotated.length) {
    await db.photo.updateMany({ where: { id: { in: unannotated.map((p) => p.id) } }, data: { annotation, annotationModel: "fixture", annotatedAt: new Date(), annotationSource: "MACHINE", reviewedAt: new Date() } });
    console.log(`annotations: ${unannotated.length} copied from the fixture`);
  }

  // Two consented adults with fixture templates, one pet, and the face-detection opt-in recorded.
  await db.appSetting.upsert({ where: { id: "app" }, update: { faceDetectionOptInAt: new Date(), faceDetectionOptInById: admin.id }, create: { id: "app", faceDetectionOptInAt: new Date(), faceDetectionOptInById: admin.id } });
  if ((await db.person.count()) === 0 && maine.length >= 2) {
    const now = new Date();
    const jo = await db.person.create({ data: { name: "Grandma Jo", relationship: "grandmother", birthday: new Date("1946-03-02"), faceIndexing: true, faceIndexingSetById: admin.id, faceIndexingSetAt: now, createdById: admin.id } });
    const dan = await db.person.create({ data: { name: "Uncle Dan", relationship: "uncle", faceIndexing: true, faceIndexingSetById: admin.id, faceIndexingSetAt: now, adultAttestedById: admin.id, adultAttestedAt: now, createdById: admin.id } });
    for (const [person, photoId, box] of [
      [jo, maine[0].id, [0.3, 0.2, 0.25, 0.35]],
      [dan, maine[1].id, [0.55, 0.25, 0.2, 0.3]],
    ] as const) {
      const vec = fixtureVector(`face:${person.name}`, 512);
      const cluster = await db.faceCluster.create({ data: { personId: person.id, label: person.name, faceCount: 1, ageBandMin: person.birthday ? 79 : null, ageBandMax: person.birthday ? 79 : null } });
      await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(vec)}::vector WHERE id = ${cluster.id}`;
      const face = await db.face.create({ data: { photoId, personId: person.id, clusterId: cluster.id, box: [...box], confidence: 0.98, status: "CONFIRMED", ageAtCaptureYears: person.birthday ? 79 : null } });
      await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${face.id}`;
    }
    const biscuit = await db.person.create({ data: { kind: "PET", name: "Biscuit", species: "DOG", livedFrom: new Date("2016-05-01"), createdById: admin.id } });
    await db.face.create({ data: { photoId: maine[2]?.id ?? maine[0].id, personId: biscuit.id, box: [0, 0, 1, 1], confidence: 0, status: "CONFIRMED" } });
    console.log("people: Grandma Jo (birthday), Uncle Dan (attested), Biscuit the dog; face detection opt-in recorded");
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
