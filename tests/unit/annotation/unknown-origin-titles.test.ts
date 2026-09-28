import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", async (original) => ({
  ...(await original<typeof import("@/lib/auth/viewer")>()),
  getViewer: async () => ({ kind: "anonymous", user: null, shareTokens: new Map() }),
  requireUserOrThrow: async () => ({ id: who.id, email: "dana@example.com", name: "Dana", role: "MEMBER" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => undefined }));

import { rejudgeSweep } from "@/lib/annotation/rejudge";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema } from "@/lib/annotation/schema";
import { searchMedia } from "@/lib/search/query";
import { setAnnotationShared } from "@/app/annotation/actions";
import { GET as infoGET } from "@/app/api/photos/[id]/info/route";
import type { Viewer } from "@/lib/auth/viewer";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
/** The members_only_text migration's own pass, run over photographs made as they were before it. */
const migrate = () => db.$executeRawUnsafe(readFileSync(path.join(process.cwd(), "prisma/migrations/20260926120100_members_only_text/migration.sql"), "utf8").match(/^DO \$\$[\s\S]*?^END \$\$;/m)![0]);
const raw = (title: string) => ({ content: [{ type: "text", text: JSON.stringify({ title, caption: "c", description: "", tags: [], searchSummary: "" }) }] });

/**
 * A title from before the album recorded who wrote titles, that names somebody, and that nothing proves is the
 * helper's: an old helper title whose answer was purged, carried over by a fold, or a member's own. Strangers never
 * read it, and it is never lost: it is kept for members.
 */
describe("titles of unknown origin that name somebody", () => {
  let tripId: string;
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: who.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", tripId, ...data } });
  const ann = (title: string) => ({ title, caption: "The cake table", description: "A cake on a table.", tags: [], searchSummary: "" });
  /** What a visitor gets: the title the lightbox shows, and whether searching the name finds it. */
  const visitor = async (id: string) => {
    const res = await infoGET(new Request(`http://x/api/photos/${id}/info`), { params: Promise.resolve({ id }) });
    const info = (await res.json()) as { title: string | null };
    const hits = (await searchMedia(anon, { q: "Ada" }, 120, null)).map((h) => h.id);
    return { title: info.title, found: hits.includes(id) };
  };
  const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id }, select: { title: true, membersTitle: true, annotationMembersOnly: true } });

  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } })).id;
    tripId = (await db.trip.create({ data: { slug: "bday", title: "Birthday", visibility: "PUBLIC", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id } })).id;
    await db.person.create({ data: { name: "Ada", createdById: who.id } });
  });

  it("A: an old helper title whose answer was purged is kept for members, not shown", async () => {
    const p = await photo({ context: "Ada turns five", title: "Ada's birthday cake", annotation: ann("Cake table") });
    await migrate();
    await rejudgeSweep();
    expect(await visitor(p.id)).toEqual({ title: null, found: false });
    expect(await row(p.id)).toEqual({ title: null, membersTitle: "Ada's birthday cake", annotationMembersOnly: true });
  });

  it("B: a title a fold carried over, whose answer is kept under the copy's id", async () => {
    const copy = await photo({ context: "Ada turns five", title: "Ada's birthday cake", annotation: ann("Ada's birthday cake"), trashedAt: new Date() });
    await db.mediaAnnotationRaw.create({ data: { photoId: copy.id, model: "m", response: raw("Ada's birthday cake") } });
    const keeper = await photo({ context: "Ada turns five", title: "Ada's birthday cake", annotation: ann("Candles on a cake") });
    await db.mediaAnnotationRaw.create({ data: { photoId: keeper.id, model: "m", response: raw("Candles on a cake") } });
    await migrate();
    await rejudgeSweep();
    expect(await visitor(keeper.id)).toEqual({ title: null, found: false });
    expect((await row(keeper.id)).membersTitle).toBe("Ada's birthday cake");
  });

  it("C: a member's edit of the helper's title keeps the member's words, for members", async () => {
    const p = await photo({ context: "Ada turns five", title: "Ada's big birthday cake", annotation: ann("Ada's birthday cake") });
    await db.mediaAnnotationRaw.create({ data: { photoId: p.id, model: "m", response: raw("Ada's birthday cake") } });
    await migrate();
    await rejudgeSweep();
    expect(await visitor(p.id)).toEqual({ title: null, found: false });
    // The helper's own title is still in its record.
    expect(await row(p.id)).toEqual({ title: null, membersTitle: "Ada's big birthday cake", annotationMembersOnly: true });
  });

  it("E: an old helper title on an item whose text names nobody any more is judged by the title itself", async () => {
    const p = await photo({ context: null, title: "Ada's birthday cake", annotation: ann("Cake table") });
    await migrate();
    expect((await row(p.id)).annotationMembersOnly).toBe(false);
    await rejudgeSweep();
    expect(await visitor(p.id)).toEqual({ title: null, found: false });
    expect(await row(p.id)).toEqual({ title: null, membersTitle: "Ada's birthday cake", annotationMembersOnly: true });
  });

  it("F: described again from notes afterwards, and before the sweep had run, it stays kept for members", async () => {
    const again = annotationSchema.parse({ ...ann("Birthday table"), place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, estimatedYear: null, estimatedPlace: null });
    const swept = await photo({ context: "Ada turns five", title: "Ada's birthday cake", annotation: ann("Cake table") });
    await migrate();
    await rejudgeSweep();
    await applyAnnotation(swept.id, "m", again, {}, { sent: true });
    expect(await visitor(swept.id)).toEqual({ title: null, found: false });
    expect((await row(swept.id)).membersTitle).toBe("Ada's birthday cake");

    await db.photo.delete({ where: { id: swept.id } });
    const unswept = await photo({ context: "Ada turns five", title: "Ada's birthday cake", annotation: ann("Cake table") });
    await migrate();
    await applyAnnotation(unswept.id, "m", again, {}, { sent: true });
    expect(await visitor(unswept.id)).toEqual({ title: null, found: false });
    expect(await row(unswept.id)).toEqual({ title: null, membersTitle: "Ada's birthday cake", annotationMembersOnly: true });
  });

  it("goes aside when a member keeps the text for the family, and is left (and said) when the members' title is taken", async () => {
    const p = await photo({ title: "Ada's birthday cake", annotation: ann("Cake table") });
    await setAnnotationShared(p.id, (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationRevision, false);
    expect(await row(p.id)).toEqual({ title: null, membersTitle: "Ada's birthday cake", annotationMembersOnly: true });

    // A members' title that is neither empty nor the helper's current one: nowhere to put it without losing words.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const q = await photo({ context: "Ada turns five", title: "Ada at the party", membersTitle: "Nana's cake", annotationMembersOnly: true, annotation: ann("Cake table") });
    await rejudgeSweep();
    expect(await row(q.id)).toEqual({ title: "Ada at the party", membersTitle: "Nana's cake", annotationMembersOnly: true });
    expect(warn.mock.calls.some(([m]) => String(m).includes(q.id) && !String(m).includes("Ada"))).toBe(true);
    warn.mockRestore();
  });
});
