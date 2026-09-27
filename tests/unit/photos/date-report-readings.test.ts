import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "date-report-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { dateReport } from "@/lib/photos/date-report";
import { applyReportedDate } from "@/app/photos/[id]/actions";

/** "Use this" on the date troubleshooter takes a camera's or a name's wall time on its own clock, never as UTC. */
describe("the date troubleshooter's readings", () => {
  let tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "me@example.com" } })).id;
    tripId = (await db.trip.create({ data: { slug: "rockies", title: "Rockies", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/Denver", createdById: who.id } })).id;
  });

  /** An uploaded file on the trip, dated from its modified time (as a scan would be). */
  async function item(name: string, exif: Record<string, string> | null) {
    const photo = await db.photo.create({ data: { uploaderId: who.id, tripId, originalName: name, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "READY", takenAt: new Date("2025-09-01T12:00:00Z"), takenAtSource: "FILE_MTIME", tzOffsetMin: -360, exif: { fileLastModified: Date.parse("2025-09-01T12:00:00Z") } } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    const img = sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 80, g: 80, b: 80 } } }).jpeg();
    await (exif ? img.withExif({ IFD0: { Make: "Canon" }, IFD2: exif }) : img).toFile(path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
    return photo.id;
  }
  const reading = async (id: string, key: string) => (await dateReport(id))!.witnesses.find((w) => w.key === key)!;
  const stored = (id: string) => db.photo.findUniqueOrThrow({ where: { id }, select: { takenAt: true, tzOffsetMin: true, takenAtSource: true } });

  it("reads the camera on the offset it wrote: 14:30 at -06:00 is 20:30 UTC", async () => {
    const id = await item("scan.jpg", { DateTimeOriginal: "2025:08:12 14:30:00", OffsetTimeOriginal: "-06:00" });
    expect(await reading(id, "exif")).toMatchObject({ at: new Date("2025-08-12T20:30:00Z"), tzOffsetMin: -360 });
    expect(await applyReportedDate(id, "exif")).toMatchObject({ ok: true, takenAt: "2025-08-12T20:30:00.000Z", tzOffsetMin: -360 });
    expect(await stored(id)).toEqual({ takenAt: new Date("2025-08-12T20:30:00Z"), tzOffsetMin: -360, takenAtSource: "MANUAL" });
  });

  it("reads a camera with no offset in the trip's zone", async () => {
    await db.trip.update({ where: { id: tripId }, data: { timezone: "America/New_York" } });
    const id = await item("scan.jpg", { DateTimeOriginal: "2025:08:12 14:30:00" });
    expect(await reading(id, "exif")).toMatchObject({ at: new Date("2025-08-12T18:30:00Z"), tzOffsetMin: -240 });
    expect(await applyReportedDate(id, "exif")).toMatchObject({ ok: true, takenAt: "2025-08-12T18:30:00.000Z", tzOffsetMin: -240 });
    expect(await stored(id)).toMatchObject({ takenAt: new Date("2025-08-12T18:30:00Z"), tzOffsetMin: -240 });
  });

  it("reads a file name's time in the trip's zone", async () => {
    const id = await item("IMG_20250812_143015.jpg", null);
    expect(await reading(id, "filename")).toMatchObject({ at: new Date("2025-08-12T20:30:15Z"), tzOffsetMin: -360 });
    expect(await applyReportedDate(id, "filename")).toMatchObject({ ok: true, takenAt: "2025-08-12T20:30:15.000Z", tzOffsetMin: -360 });
    // An instant with no zone of its own keeps the item's clock; a reading with nothing to say cannot be taken.
    expect(await applyReportedDate(id, "upload")).toMatchObject({ ok: true, tzOffsetMin: -360 });
    expect(await applyReportedDate(id, "exif")).toMatchObject({ ok: false });
  });
});
