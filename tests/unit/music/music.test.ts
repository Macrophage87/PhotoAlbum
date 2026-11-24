import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { createDeviceToken } from "@/lib/auth/device-token";
import { CAST_LINK_MS } from "@/lib/cast/link";
import { CAST_ADDRESS, CAST_NAMESPACE, CAST_THUMB, receiverPage, receiverScript } from "@/lib/cast/receiver-page";
import { songCastUrl, songLinkGood, songTitle, songType } from "@/lib/music/songs";
import { POST as add } from "@/app/api/music/route";
import { DELETE as remove, GET as bytes } from "@/app/api/music/[id]/route";
import { GET as list } from "@/app/api/v1/album/music/route";
import { GET as slideshow } from "@/app/api/v1/album/slideshow/route";
import { GET as receiver } from "@/app/cast/receiver/route";
import { GET as media } from "@/app/api/photos/[id]/[size]/route";

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`http://album.test${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) } });
const upload = (name: string, body: string, token?: string, type = "audio/mpeg") =>
  add(req("/api/music", token, { method: "POST", body, headers: { "content-type": type, "x-file-name": encodeURIComponent(name) } }));
const at = (id: string) => ({ params: Promise.resolve({ id }) });

describe("what counts as a song", () => {
  it("goes by the file's ending first, then by what the sender called it", () => {
    expect(songType("a.MP3", "application/octet-stream")).toBe("audio/mpeg");
    expect(songType("a.m4a", null)).toBe("audio/mp4");
    expect(songType("a", "audio/x-m4a")).toBe("audio/mp4");
    expect(songType("a", "audio/mp3; charset=binary")).toBe("audio/mpeg");
    expect(songType("a.jpg", "image/jpeg")).toBeNull();
    expect(songType("a.exe", "application/octet-stream")).toBeNull();
  });
  it("is called after its file", () => {
    expect(songTitle("C:\\Music\\01_Summer  Wind.mp3")).toBe("01 Summer Wind");
    expect(songTitle(".mp3")).toBe("Untitled");
  });
});

describe("a song's signed address", () => {
  it("opens that song for a few hours, and nothing else", async () => {
    const now = 1_800_000_000_000;
    const token = new URL(`http://x${await songCastUrl("s1", now)}`).searchParams.get("cast");
    expect(await songLinkGood("s1", token, now)).toBe(true);
    expect(await songLinkGood("s1", token, now + CAST_LINK_MS)).toBe(false);
    expect(await songLinkGood("s2", token, now)).toBe(false);
    expect(await songLinkGood("s1", null, now)).toBe(false);
  });
});

describe("the album's music", () => {
  let token: string, other: string, admin: string;

  beforeEach(async () => {
    await resetTestDb();
    token = (await createDeviceToken(db, (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id, "Pixel")).token;
    other = (await createDeviceToken(db, (await db.user.create({ data: { email: "sam@example.com", name: "Sam" } })).id, "Pixel")).token;
    admin = (await createDeviceToken(db, (await db.user.create({ data: { email: "ada@example.com", name: "Ada", role: "ADMIN" } })).id, "Pixel")).token;
  });

  it("takes a song from a member only, and only a music file with something in it", async () => {
    expect((await upload("tune.mp3", "abc")).status).toBe(401);
    expect((await upload("tune.jpg", "abc", token, "image/jpeg")).status).toBe(415);
    expect((await upload("tune.mp3", "", token)).status).toBe(422);
    expect(await db.song.count()).toBe(0);
    const res = await upload("Summer Wind.mp3", "0123456789", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Summer Wind" });
    expect(await db.song.findFirst({ select: { mimeType: true, sizeBytes: true } })).toEqual({ mimeType: "audio/mpeg", sizeBytes: 10 });
  });

  it("plays it back to a member, whole or in part, and to nobody without a signed address", async () => {
    const { id } = await (await upload("tune.mp3", "0123456789", token)).json();
    expect((await bytes(req(`/api/music/${id}`), at(id))).status).toBe(401);
    const whole = await bytes(req(`/api/music/${id}`, other), at(id));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mpeg");
    expect(await whole.text()).toBe("0123456789");
    const part = await bytes(req(`/api/music/${id}`, other, { headers: { range: "bytes=2-5" } }), at(id));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect((await bytes(req(`/api/music/nothing`, other), at("nothing"))).status).toBe(404);
  });

  it("lists the songs for the app, each with an address a television can fetch with no sign-in", async () => {
    expect((await list(req("/api/v1/album/music"))).status).toBe(401);
    const { id } = await (await upload("tune.mp3", "0123456789", token)).json();
    const body = await (await list(req("/api/v1/album/music", other))).json();
    expect(body.songs).toEqual([{ id, title: "tune", cast: expect.stringMatching(new RegExp(`^/api/music/${id}\\?cast=\\d+\\.[A-Za-z0-9_-]{43}$`)) }]);
    const cast = body.songs[0].cast as string;
    expect(CAST_ADDRESS.test(cast)).toBe(true);
    const played = await bytes(req(cast), at(id));
    expect(played.status).toBe(200);
    expect(await played.text()).toBe("0123456789");
    // One song's address opens no other, and a photograph's opens no song.
    const second = (await (await upload("more.mp3", "abc", token)).json()).id as string;
    expect((await bytes(req(cast.replace(id, second)), at(second))).status).toBe(401);
  });

  it("is taken out by whoever added it or an admin, and nobody else", async () => {
    const { id } = await (await upload("tune.mp3", "0123456789", token)).json();
    expect((await remove(req(`/api/music/${id}`, undefined, { method: "DELETE" }), at(id))).status).toBe(401);
    expect((await remove(req(`/api/music/${id}`, other, { method: "DELETE" }), at(id))).status).toBe(403);
    expect((await remove(req(`/api/music/${id}`, token, { method: "DELETE" }), at(id))).status).toBe(200);
    expect((await bytes(req(`/api/music/${id}`, token), at(id))).status).toBe(404);
    const again = (await (await upload("tune.mp3", "0123456789", token)).json()).id as string;
    expect((await remove(req(`/api/music/${again}`, admin, { method: "DELETE" }), at(again))).status).toBe(200);
    expect(await db.song.count()).toBe(0);
  });
});

describe("the page a television opens", () => {
  it("is plain public HTML that listens on the album's own channel", async () => {
    const res = receiver();
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = await res.text();
    expect(page).toBe(receiverPage());
    expect(page).toContain(CAST_NAMESPACE);
    expect(page).toContain("cast_receiver_framework.js");
    expect(page).not.toContain("__NS__");
    expect(page).not.toContain("__OK__");
    expect(page).not.toContain("__THUMB__");
    expect(page).not.toContain("__TILES__");
    // Sound JavaScript: a slip in the script would otherwise only show as a blank television.
    expect(() => new Function("cast", "document", receiverScript())).not.toThrow();
  });

  it("will fetch a slide or a song from this album and nothing else", async () => {
    await resetTestDb();
    const userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
    const token = (await createDeviceToken(db, userId, "Pixel")).token;
    const trip = await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } });
    await db.photo.create({ data: { tripId: trip.id, uploaderId: userId, originalName: "a", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY", width: 100, height: 80, takenAt: new Date("2025-08-11T15:00:00Z") } });
    const body = await (await slideshow(req("/api/v1/album/slideshow?trip=coast", token))).json();
    expect(CAST_ADDRESS.test(body.slides[0].cast)).toBe(true);
    for (const bad of ["https://elsewhere.example/api/photos/a/preview?cast=1.a", "//elsewhere.example/api/music/a?cast=1.a", "/api/photos/a/original?cast=1.a", "/api/music/a", "/api/music/../admin?x=1", "javascript:alert(1)", "/api/music/a?cast=1.a#<script>"]) expect(CAST_ADDRESS.test(bad)).toBe(false);
  });

  it("is given clips, names and places for a slide only when a member's app asks", async () => {
    await resetTestDb();
    const userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
    const token = (await createDeviceToken(db, userId, "Pixel")).token;
    const trip = await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } });
    const mk = async (name: string, extra: Record<string, unknown> = {}) =>
      (await db.photo.create({ data: { tripId: trip.id, uploaderId: userId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 80, ...extra } })).id;
    const photo = await mk("photo", { takenAt: new Date("2025-08-11T15:00:00Z"), lat: 38.9, lng: -77.03 });
    const clip = await mk("clip", { kind: "VIDEO", takenAt: new Date("2025-08-11T16:00:00Z"), durationS: 12.5, videoRenditions: { mp4: { key: "clip/v.mp4", w: 100, h: 80, bytes: 1 }, poster: { key: "clip/p.jpg" } } });
    // On YouTube, and one the album has not finished making a copy of: neither can be played by the television.
    await mk("tube", { kind: "VIDEO", sourceKind: "YOUTUBE", externalId: "abc", takenAt: new Date("2025-08-11T17:00:00Z") });
    await mk("raw", { kind: "VIDEO", takenAt: new Date("2025-08-11T18:00:00Z") });
    const ada = await db.person.create({ data: { name: "Ada", createdById: userId } });
    const gone = await db.person.create({ data: { name: "Gone", createdById: userId, optedOutAt: new Date() } });
    await db.face.create({ data: { photoId: photo, personId: ada.id, status: "CONFIRMED", box: {}, confidence: 1 } });
    await db.face.create({ data: { photoId: photo, personId: gone.id, status: "CONFIRMED", box: {}, confidence: 1 } });

    const plain = await (await slideshow(req("/api/v1/album/slideshow?trip=coast", token))).json();
    expect(plain.slides.map((s: { id: string }) => s.id)).toEqual([photo]);
    expect(plain.slides[0]).toMatchObject({ people: ["Ada"], lat: 38.9, lng: -77.03, video: null, seconds: null });
    expect(CAST_THUMB.test(plain.slides[0].thumb)).toBe(true);

    const withClips = await (await slideshow(req("/api/v1/album/slideshow?trip=coast&clips=1", token))).json();
    expect(withClips.slides.map((s: { id: string }) => s.id)).toEqual([photo, clip]);
    const video = withClips.slides[1].video as string;
    expect(withClips.slides[1]).toMatchObject({ seconds: 12.5, people: [] });
    expect(CAST_ADDRESS.test(video)).toBe(true);

    // The clip's signed address gets past the door with no sign-in (there is no file here, so it is "not found", not "unauthorized")...
    const at = (id: string, size: string) => ({ params: Promise.resolve({ id, size }) });
    expect((await media(req(video), at(clip, "video"))).status).toBe(404);
    expect((await media(req(`/api/photos/${clip}/video`), at(clip, "video"))).status).toBe(401);
    // ...and opens neither the file as uploaded nor another item.
    expect((await media(req(video.replace("/video?", "/original?")), at(clip, "original"))).status).toBe(401);
    expect((await media(req(video.replace(clip, photo)), at(photo, "video"))).status).toBe(401);
  });
});
