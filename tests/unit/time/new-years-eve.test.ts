import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer, requireUserOrThrow: async () => who.viewer.user }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { tileDate } from "@/components/photos/PhotoGrid";
import { outsiderAlt, takenDay, takenYearSpan, toGridPhoto } from "@/components/photos/toGrid";
import { readingTime } from "@/components/photos/DateTroubleshooter";
import { formatTaken } from "@/components/photos/LightboxInfo";
import { GET as photoInfo } from "@/app/api/photos/[id]/info/route";
import type { PhotoInfo } from "@/app/api/photos/[id]/info/route";
import { dateReport } from "@/lib/photos/date-report";
import { guessDate } from "@/lib/photos/date-from-neighbours";
import { idsInLocalYear, tripPhotoPage } from "@/lib/photos/page";
import { searchFacets, searchMedia } from "@/lib/search/query";
import { listCollectionItems } from "@/lib/collections/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { tripTimeline } from "@/lib/timeline/queries";
import { favouritePhotos, setFavourite } from "@/lib/favourites/queries";
import { unplacedForTray } from "@/lib/photos/unplaced";
import { loadItem } from "@/lib/suggest/index";
import { formatLocalTime, formatTakenAt } from "@/lib/time/format";

const LA = "America/Los_Angeles";
/** 11:30 PM on 31 December in Los Angeles, which is already 1 January in UTC. */
const NYE = new Date("2026-01-01T07:30:00Z");
const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

/**
 * A photograph with no offset of its own (Google's record says only the instant) on a trip in Los Angeles, taken at
 * 11:30 PM on New Year's Eve. Everywhere the album shows its day or its year, that is 31 December 2025: its trip's
 * zone, not UTC, where it has no offset of its own (#144).
 */
describe("a New Year's Eve photograph with no offset of its own, on a trip in Los Angeles", () => {
  let member: Viewer, tripId: string, photoId: string, collectionId: string;

  beforeAll(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    member = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
    tripId = (await db.trip.create({ data: { slug: "la", title: "Los Angeles", timezone: LA, startDate: new Date("2025-12-29"), endDate: new Date("2026-01-02"), createdById: u.id } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: u.id, tripId, originalName: "pier.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", caption: "Fireworks over the pier", takenAt: NYE, tzOffsetMin: null, takenAtSource: "SIDECAR" } })).id;
    // A public collection holding it, so a stranger reaches it with nothing of its private trip.
    collectionId = (await db.collection.create({ data: { slug: "nye", title: "New Year's Eves", visibility: "PUBLIC", createdById: u.id } })).id;
    await db.collectionItem.create({ data: { collectionId, photoId, addedById: u.id } });
    who.viewer = member;
  });

  it("dates its gallery tile, on a trip's gallery and on a share page, 31 December", async () => {
    const [card] = (await tripPhotoPage(tripId)).photos;
    expect(tileDate(toGridPhoto(card, null, member.user).takenDay)).toBe("Dec 31, 2025");
    // A share page's tile is drawn for nobody in particular.
    const [shared] = (await tripPhotoPage(tripId, { readyOnly: true })).photos;
    expect(tileDate(toGridPhoto(shared).takenDay)).toBe("Dec 31, 2025");
    // What a stranger's screen reader hears for an item with no caption.
    expect(outsiderAlt(card)).toBe("Photo taken December 31, 2025");
  });

  it("dates its tile on a collection page and on the favorites page 31 December", async () => {
    const [inCollection] = await listCollectionItems(collectionId);
    expect(tileDate(toGridPhoto(inCollection, null, member.user).takenDay)).toBe("Dec 31, 2025");
    await setFavourite("photo", photoId, member.user!.id, true);
    const [favourite] = await favouritePhotos({}, "mine", member.user!.id);
    expect(tileDate(toGridPhoto(favourite, null, member.user).takenDay)).toBe("Dec 31, 2025");
  });

  it("shows it on the photo's page on 31 December", () => {
    expect(formatTakenAt(NYE, null, LA)).toBe("Wed, Dec 31, 2025 · 11:30 PM");
  });

  it("dates it 31 December in the lightbox, for a member and for a stranger who may not know its trip", async () => {
    const info = async (viewer: Viewer) => {
      who.viewer = viewer;
      const res = await photoInfo(new Request(`http://localhost/api/photos/${photoId}/info`), { params: Promise.resolve({ id: photoId }) });
      return (await res.json()) as PhotoInfo;
    };
    const mine = await info(member);
    expect(mine).toMatchObject({ timezone: LA, tzOffsetMin: null });
    // The stranger is not told the trip's zone, only the offset it gives that moment.
    const theirs = await info(anon);
    expect(theirs).toMatchObject({ timezone: null, tzOffsetMin: -480 });
    expect(formatTaken(theirs.takenAt!, theirs.tzOffsetMin)).toBe("Wed, Dec 31, 2025, 11:30 PM");
    who.viewer = member;
  });

  it("reads 31 December in the date troubleshooter", async () => {
    const report = JSON.parse(JSON.stringify(await dateReport(photoId)));
    expect(report.current.shownOffsetMin).toBe(-480);
    expect(readingTime(report.current.at, report.current.shownOffsetMin)).toBe("December 31, 2025 at 11:30 PM");
  });

  it("names a neighbour's time in the trip's zone, and keeps that offset for the guess", () => {
    const shot = (name: string, at: string) => ({ id: name, originalName: name, takenAt: new Date(at), tzOffsetMin: null });
    const trip = { startDate: new Date("2025-12-29"), endDate: new Date("2026-01-02"), tzOffsetMin: -480, timezone: LA };
    const between = guessDate({ id: "x", originalName: "IMG_0002.jpg" }, [shot("IMG_0001.jpg", "2026-01-01T07:30:00Z"), shot("IMG_0003.jpg", "2026-01-01T07:40:00Z")], { trip })!;
    expect(between.evidence).toBe("between IMG_0001.jpg (Dec 31, 11:30 PM) and IMG_0003.jpg (Dec 31, 11:40 PM)");
    expect(between.tzOffsetMin).toBe(-480);
    const after = guessDate({ id: "x", originalName: "IMG_0002.jpg" }, [shot("IMG_0001.jpg", "2026-01-01T07:30:00Z")], { trip })!;
    expect(after).toMatchObject({ tzOffsetMin: -480, evidence: "just after IMG_0001.jpg (Dec 31, 11:30 PM)" });
    const alike = guessDate({ id: "x", originalName: "scan.jpg" }, [shot("IMG_0001.jpg", "2026-01-01T07:30:00Z")], { trip, similarIds: ["IMG_0001.jpg"] })!;
    expect(alike).toMatchObject({ tzOffsetMin: -480, evidence: "about when the photo it looks most like was taken (Dec 31, 11:30 PM)" });
  });

  it("puts it in 2025 in the year filters of galleries and search, and offers 2025 alone", async () => {
    expect(await idsInLocalYear(tripId, 2025)).toEqual([photoId]);
    expect(await idsInLocalYear(tripId, 2026)).toEqual([]);
    // A collection's and the whole album's filters ask of every trip.
    expect(await idsInLocalYear(null, 2025)).toEqual([photoId]);
    expect(await idsInLocalYear(null, 2026)).toEqual([]);
    expect((await searchMedia(member, { q: "fireworks", year: 2025 }, 120, null)).map((h) => h.id)).toEqual([photoId]);
    expect(await searchMedia(member, { q: "fireworks", year: 2026 }, 120, null)).toEqual([]);
    expect((await searchFacets(member)).years).toEqual([2025]);
    // The date beside a search hit.
    const [hit] = await searchMedia(member, { q: "fireworks" }, 120, null);
    expect(takenDay({ ...hit, trip: hit.tripTimezone ? { timezone: hit.tripTimezone } : null })).toBe("2025-12-31");
  });

  it("files it under 31 December on the trip's and the collection's timelines, at 11:30 PM, and in 2025 on the collection's overview", async () => {
    expect((await tripTimeline(tripId, LA)).groups.map((g) => g.dayKey)).toEqual(["2025-12-31"]);
    const { groups } = await collectionTimeline(collectionId);
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-12-31"]);
    const [p] = groups[0].items[0].photos;
    // The collection's timeline is drawn with no zone of its own: each photo carries its trip's offset.
    expect(formatLocalTime(p.takenAt!, { offsetMin: p.tzOffsetMin, timezone: "UTC" })).toBe("11:30 PM");
    expect(tileDate(toGridPhoto(p, null, member.user).takenDay)).toBe("Dec 31, 2025");
    expect(takenYearSpan(await listCollectionItems(collectionId))).toBe("2025");
  });

  it("dates it 31 December in the map's tray and in the suggestions", async () => {
    const tray = await unplacedForTray(member.user!);
    expect(tray.photos.find((p) => p.id === photoId)?.day).toBe("2025-12-31");
    expect((await loadItem(photoId))?.day).toBe("2025-12-31");
  });

  it("still files a ride past midnight under the day it began", async () => {
    // 11 PM on New Year's Eve to 1 AM, with a photograph on it at half past midnight: all of it under 31 December.
    const ride = await db.activity.create({ data: { tripId, title: "Midnight ride", startTime: new Date("2026-01-01T07:00:00Z"), endTime: new Date("2026-01-01T09:00:00Z") } });
    const late = await db.photo.create({ data: { uploaderId: member.user!.id, tripId, activityId: ride.id, originalName: "late.jpg", mimeType: "image/jpeg", storageKey: "k2", originalPath: "k2/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2026-01-01T08:30:00Z"), tzOffsetMin: null, takenAtSource: "SIDECAR" } });
    const { groups } = await tripTimeline(tripId, LA);
    expect(groups.map((g) => g.dayKey)).toEqual(["2025-12-31"]);
    const onRide = groups[0].items.find((i) => i.kind === "activity");
    expect(onRide?.photos.map((p) => p.id)).toEqual([late.id]);
  });
});
