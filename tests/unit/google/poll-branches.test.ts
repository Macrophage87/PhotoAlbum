import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

// The Picker actions with Google mocked out: what each kind of picked item turns into, the trip it is filed on,
// what a failure tells the member, and how the progress check counts.
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "pb@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const auth = vi.hoisted(() => ({ token: vi.fn(), noted: [] as unknown[] }));
vi.mock("@/lib/google/account", async () => {
  const { GoogleAuthError } = await import("@/lib/google/oauth");
  return {
    accessTokenFor: auth.token,
    // As the real one: only an auth error that needs a reconnect counts.
    noteAuthFailure: async (_u: string, err: unknown) => { auth.noted.push(err); return err instanceof GoogleAuthError && err.needsReconnect; },
    disconnectGoogleAccount: async () => undefined,
  };
});
const google = vi.hoisted(() => ({ session: vi.fn(), items: [] as unknown[] }));
vi.mock("@/lib/google/picker", async (orig) => ({ ...(await orig()) as object, getPickerSession: google.session, listPickedItems: async () => google.items }));
const queue = vi.hoisted(() => ({ sent: [] as { photoIds: string[]; items: Record<string, { id: string }> }[] }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (_q: string, data: never) => { queue.sent.push(data); return "job"; } }));

import { pickerProgress, pollPickerSession } from "@/app/google/actions";
import { GoogleAuthError } from "@/lib/google/oauth";
import { PickerSessionGone } from "@/lib/google/picker";

const item = (id: string, filename: string, mimeType: string, type = "PHOTO") => ({ id, type, baseUrl: `https://lh3.googleusercontent.com/${id}`, mimeType, filename, createTime: null, width: null, height: null });

describe("pollPickerSession", () => {
  beforeEach(async () => {
    await resetTestDb();
    queue.sent.length = 0;
    auth.noted.length = 0;
    auth.token.mockReset().mockResolvedValue("tok");
    google.session.mockReset().mockResolvedValue({ id: "s1", mediaItemsSet: true, deadline: Date.now() + 60_000 });
    who.id = (await db.user.create({ data: { email: "pb@example.com", role: "MEMBER" } })).id;
  });

  it("turns a photo, a clip, a raw file and an item already in the album into rows, an unsupported count and a skip", async () => {
    const had = await db.photo.create({ data: { uploaderId: who.id, sourceKind: "GOOGLE_PICKER", sourceId: "gp-old", status: "READY", originalName: "old.jpg", mimeType: "image/jpeg", storageKey: "photos/o", originalPath: "photos/o/original.jpg", sizeBytes: 9 } });
    google.items = [
      item("gp-photo", "beach.jpg", "image/jpeg; charset=binary"),
      item("gp-clip", "waves.MOV", "", "VIDEO"),
      item("gp-raw", "IMG_0001.CR2", "image/x-canon-cr2"),
      item("gp-old", "old.jpg", "image/jpeg"),
    ];
    const r = await pollPickerSession("s1", null);
    expect(r).toMatchObject({ state: "queued", skipped: 1, unsupported: 1 });
    const rows = await db.photo.findMany({ where: { id: { not: had.id } }, orderBy: { sourceId: "asc" }, select: { id: true, sourceId: true, kind: true, mimeType: true, status: true, originalPath: true, tripId: true } });
    expect(rows).toEqual([
      // No type from Google: the extension decides, as it does for an upload.
      expect.objectContaining({ sourceId: "gp-clip", kind: "VIDEO", mimeType: "video/quicktime", status: "PENDING", originalPath: "pending" }),
      // A parameter after the type is dropped rather than making it unsupported.
      expect.objectContaining({ sourceId: "gp-photo", kind: "PHOTO", mimeType: "image/jpeg", status: "PENDING", originalPath: "pending" }),
    ]);
    expect((r as { photoIds: string[] }).photoIds.sort()).toEqual(rows.map((x) => x.id).sort());
    // One job, carrying exactly the rows it made and the item each one is to fetch.
    expect(queue.sent).toHaveLength(1);
    expect(Object.fromEntries(Object.entries(queue.sent[0].items).map(([k, v]) => [k, v.id]))).toEqual(Object.fromEntries(rows.map((x) => [x.id, x.sourceId])));
  });

  it("files new rows on the trip it was asked for, and on no trip when that trip is gone or being deleted", async () => {
    const trip = await db.trip.create({ data: { slug: "shore", title: "Shore", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id } });
    const going = await db.trip.create({ data: { slug: "gone", title: "Gone", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id, deletingAt: new Date() } });
    google.items = [item("gp-a", "a.jpg", "image/jpeg")];
    await pollPickerSession("s1", trip.id);
    google.items = [item("gp-b", "b.jpg", "image/jpeg")];
    await pollPickerSession("s2", "no-such-trip");
    google.items = [item("gp-c", "c.jpg", "image/jpeg")];
    await pollPickerSession("s3", going.id);
    const rows = await db.photo.findMany({ orderBy: { sourceId: "asc" }, select: { sourceId: true, tripId: true } });
    expect(rows).toEqual([{ sourceId: "gp-a", tripId: trip.id }, { sourceId: "gp-b", tripId: null }, { sourceId: "gp-c", tripId: null }]);
  });

  it("queues nothing when everything picked is unsupported", async () => {
    google.items = [item("gp-raw", "IMG_0001.cr2", "")];
    expect(await pollPickerSession("s1", null)).toEqual({ state: "queued", photoIds: [], skipped: 0, unsupported: 1 });
    expect(queue.sent).toHaveLength(0);
    expect(await db.photo.count()).toBe(0);
  });

  it("keeps watching while the member is still picking, and says the session ended once it is past its time", async () => {
    google.session.mockResolvedValueOnce({ id: "s1", mediaItemsSet: false, deadline: Date.now() + 60_000 });
    expect(await pollPickerSession("s1", null)).toEqual({ state: "picking" });
    google.session.mockResolvedValueOnce({ id: "s1", mediaItemsSet: false, deadline: Date.now() - 1 });
    expect(await pollPickerSession("s1", null)).toEqual({ state: "error", reconnect: false, message: "That picking session has ended; start again." });
  });

  it("asks the member to connect again only when Google says the grant is gone", async () => {
    auth.token.mockRejectedValueOnce(new GoogleAuthError("invalid_grant", true));
    expect(await pollPickerSession("s1", null)).toEqual({ state: "error", reconnect: true, message: "Google Photos needs to be connected again." });
    // A refusal that is not about the grant (a 403 on one call) is reported, not turned into "connect again".
    google.session.mockRejectedValueOnce(new GoogleAuthError("Google Photos refused the request (403)", false));
    expect(await pollPickerSession("s1", null)).toEqual({ state: "error", reconnect: false, message: "Google Photos refused the request (403)" });
    google.session.mockRejectedValueOnce(new PickerSessionGone("gone"));
    expect(await pollPickerSession("s1", null)).toEqual({ state: "error", reconnect: false, message: "That picking session has ended; start again." });
    google.session.mockRejectedValueOnce("not an error");
    expect(await pollPickerSession("s1", null)).toEqual({ state: "error", reconnect: false, message: "Google Photos is not responding." });
    expect(auth.noted).toHaveLength(4);
  });
});

describe("pickerProgress", () => {
  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "pb@example.com", role: "MEMBER" } })).id;
  });

  it("counts ready and failed rows, and a row that has gone as failed, so the button always reaches the end", async () => {
    const base = { uploaderId: who.id, sourceKind: "GOOGLE_PICKER" as const, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 };
    const ready = await db.photo.create({ data: { ...base, sourceId: "a", status: "READY", originalName: "a.jpg" } });
    const failed = await db.photo.create({ data: { ...base, sourceId: "b", status: "FAILED", originalName: "b.jpg" } });
    const waiting = await db.photo.create({ data: { ...base, sourceId: "c", status: "PROCESSING", originalName: "c.jpg" } });
    expect(await pickerProgress([ready.id, failed.id, waiting.id, "deleted-meanwhile"])).toEqual({ total: 4, done: 1, failed: 2 });
    await db.photo.update({ where: { id: waiting.id }, data: { status: "READY" } });
    const p = await pickerProgress([ready.id, failed.id, waiting.id, "deleted-meanwhile"]);
    expect(p.done + p.failed).toBe(p.total);
  });
});
