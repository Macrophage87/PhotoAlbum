import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** Title, caption and notes feed the text embedding, so a member's edit to any of them must re-embed the item. */
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
});
const who = vi.hoisted(() => ({ id: "" }));
const sent = vi.hoisted(() => [] as { queue: string; data: { photoId: string; textOnly?: boolean } }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "t@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: { photoId: string; textOnly?: boolean }) => { sent.push({ queue, data }); } }));
const ml = vi.hoisted(() => ({ text: vi.fn() }));
vi.mock("@/lib/ml/client", async (orig) => ({ ...(await orig()) as object, embedText: ml.text }));

import { updatePhoto } from "@/app/photos/[id]/actions";
import { embedPhoto } from "@/lib/jobs/handlers/embed-photo";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("refreshing the text embedding", () => {
  let photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    sent.length = 0;
    ml.text.mockReset();
    who.id = (await db.user.create({ data: { email: "t@example.com", role: "MEMBER" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: who.id, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY", caption: "At the lake" } })).id;
  });
  const textJobs = () => sent.filter((s) => s.queue === "embed-photo" && s.data.textOnly).map((s) => s.data.photoId);

  it("is queued when a member retitles an item", async () => {
    await updatePhoto(photoId, form({ title: "Emma's first birthday", caption: "At the lake", context: "", tripId: "" }));
    expect(textJobs()).toEqual([photoId]);
  });

  it("is queued when only the notes change", async () => {
    await updatePhoto(photoId, form({ caption: "At the lake", context: "Grandma took this", tripId: "" }));
    expect(textJobs()).toEqual([photoId]);
  });

  it("is not queued when the words are unchanged", async () => {
    await updatePhoto(photoId, form({ caption: "At the lake", context: "", tripId: "" }));
    expect(textJobs()).toEqual([]);
  });

  it("clears the old vector once every word is gone", async () => {
    const v = Array.from({ length: 384 }, () => 0.05);
    await db.$executeRaw`UPDATE "Photo" SET "textEmbedding" = ${`[${v.join(",")}]`}::vector WHERE id = ${photoId}`;
    await db.photo.update({ where: { id: photoId }, data: { caption: null } });
    await embedPhoto({ photoId, textOnly: true });
    expect(ml.text).not.toHaveBeenCalled();
    const [row] = await db.$queryRaw<{ has: boolean }[]>`SELECT "textEmbedding" IS NOT NULL AS has FROM "Photo" WHERE id = ${photoId}`;
    expect(row.has).toBe(false);
  });
});
