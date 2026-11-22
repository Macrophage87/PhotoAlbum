import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
// A forget that crashes at the very end: deleting the record fails once asked to (see the last test).
const crash = vi.hoisted(() => ({ on: false, at: null as Date | null }));
vi.mock("@/lib/annotation/rejudge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/annotation/rejudge")>();
  return {
    ...real,
    forgetJudgedNames: async (...args: Parameters<typeof real.forgetJudgedNames>) => {
      if (crash.on) {
        crash.at = (await db.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t;
        throw new Error("crashed at the very end");
      }
      return real.forgetJudgedNames(...args);
    },
  };
});

import { strictMatcher } from "@/lib/people/strict-names";
import { nameMatcher } from "@/lib/people/scrub";
import { forgetPerson } from "@/lib/people/forget-person";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/** Issue #148: the rare cases left after Release F, from the issue's own examples. */
const record = (over: Partial<StoredAnnotation> = {}): StoredAnnotation => ({ title: "", caption: "", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", ...over });

describe("the share guard (#148)", () => {
  const refused: [string, string, string[]?][] = [
    // Handles and run-together capitals, as hashtags.
    ["May Chen", "@MayChen on her birthday"],
    ["May Chen", "Thanks @may.chen!"],
    ["May", "Banner: HAPPYBIRTHDAYMAY"],
    // Other joiners before a month and a year: a list of names, not a date.
    ["May", "Ben; May 2019"],
    ["May", "Ben or May 2019"],
    ["May", "Ben 'n' May 2019"],
    ["May", "Ben—May 2019"],
    // A person after the year, the next word or the one after.
    ["May", "May 2019 twins"],
    ["May", "May 2019 birthday girl"],
    ["June", "June 2020 big sister!"],
    // Hashtags: another spelling, a hyphen inside, and a name past the 60th letter.
    ["Madison", "#maddison"],
    ["Madison", "#madi-son"],
    ["Maddison", "#TeamMadison"],
    ["Madison", `#${"a".repeat(70)}madison`],
    // A zero-width space as the only separator is no full name of somebody else's.
    ["Jordan", "Tom\u200bJordan at the lake", ["Tom Jordan"]],
    ["Jordan", "Tom\u2060Jordan", ["Tom Jordan"]],
  ];
  it.each(refused)("refuses %s in %j", (name, text, others) => {
    expect(strictMatcher([name], others ?? [])(text)).toBe(true);
  });

  const shared: [string, string, string[]?][] = [
    ["May", "May 2019"],
    ["May", "In May 2019 we moved."],
    ["May", "Photos: May 2019"],
    ["May", "May 2019 family photos"],
    ["May", "HAPPY BIRTHDAY GRANDPA"],
    ["May", "@grandpa_joe at the lake"],
    // Somebody else's full name, written out, is theirs.
    ["Jordan", "Tom Jordan at the lake", ["Tom Jordan"]],
  ];
  it.each(shared)("leaves %s alone in %j", (name, text, others) => {
    expect(strictMatcher([name], others ?? [])(text)).toBe(false);
  });

  it("still finds a name hidden by an invisible character inside it", () => {
    expect(strictMatcher(["Madison"])("Madi\u00adson at the park")).toBe(true);
  });
});

describe("on her own photographs, at forget time (#148)", () => {
  const own = { tagged: true };
  it("takes out handles, runs of capitals and hashtags of hers whole", () => {
    const m = nameMatcher(["May Chen"]);
    expect(m.scrub("@MayChen on her birthday", own)).toBe("A family member on her birthday");
    expect(m.scrub("Banner: HAPPYBIRTHDAYMAY", own)).toBe("Banner: a family member");
    expect(m.scrub("Ben; May 2019", own)).toBe("Ben; a family member 2019");
    expect(m.scrub("May 2019 birthday girl", own)).toBe("A family member 2019 birthday girl");
    expect(m.scrub("May 2019 at the lake", own)).toBe("May 2019 at the lake");
    const madison = nameMatcher(["Madison Lee"]);
    expect(madison.scrub("Cake #maddison #madi-son", own)).toBe("Cake a family member a family member");
  });

  it("keeps two hashtags side by side as two mentions", () => {
    expect(nameMatcher(["May Chen"]).scrub("Cake #TeamMay #MayDay", { tagged: true })).toBe("Cake a family member a family member");
    // Two of her names side by side are still one.
    expect(nameMatcher(["Ada Byron"]).scrub("byron ada at the lake", { tagged: true })).toBe("A family member at the lake");
  });

  it("parts two names joined only by a zero-width space", () => {
    expect(nameMatcher(["Jordan"], ["Tom Jordan"]).scrub("Tom\u200bJordan at the lake", { tagged: true })).not.toMatch(/Jordan/u);
    expect(nameMatcher(["Jordan"], ["Tom Jordan"]).scrub("Tom Jordan at the lake", { tagged: true })).toBe("Tom Jordan at the lake");
  });
});

describe("forgetting, and later answers (#148)", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    crash.on = false;
    crash.at = null;
    admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });
  const mk = (id: string, data: Record<string, unknown> = {}) => db.photo.create({ data: { id, uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: id, originalPath: `${id}/o.jpg`, sizeBytes: 1, status: "READY", ...data } });
  const tag = (photoId: string, personId: string) => db.face.create({ data: { photoId, personId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
  const caption = async (id: string) => ((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption;

  it("takes a handle and a run of capitals off her photograph, and out of later answers", async () => {
    const may = await db.person.create({ data: { name: "May Chen", createdById: admin } });
    const p = await mk("m", { annotation: record({ caption: "@MayChen on her birthday", description: "Banner: HAPPYBIRTHDAYMAY" }), annotatedAt: new Date() });
    await tag(p.id, may.id);
    await forgetPerson(may.id, { keepName: false, byUserId: admin });
    const a = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation;
    expect([a.caption, a.description]).toEqual(["A family member on her birthday", "Banner: a family member"]);
    const ts = await loadTombstone();
    const scope = await forgottenScope({ photoIds: [p.id] });
    for (const [t, want] of [
      ["@MayChen on her birthday", "A family member on her birthday"],
      ["Banner: HAPPYBIRTHDAYMAY", "Banner: a family member"],
      ["Cake #TeamMay #MayDay", "Cake a family member a family member"],
    ]) expect([t, ts.scrub(t, scope)]).toEqual([t, want]);
  });

  it("finds another spelling, a hyphen and a name past the 60th letter in a hashtag in a later answer", async () => {
    const madison = await db.person.create({ data: { name: "Madison", createdById: admin } });
    const p = await mk("h", { annotation: record({ caption: "Cake #maddison" }), annotatedAt: new Date() });
    await tag(p.id, madison.id);
    await forgetPerson(madison.id, { keepName: false, byUserId: admin });
    expect(await caption(p.id)).toBe("Cake a family member");
    const ts = await loadTombstone();
    const scope = await forgottenScope({ photoIds: [p.id] });
    for (const t of ["#maddison", "#madi-son", `#${"a".repeat(70)}madison`, `#${"b".repeat(600)}`]) expect([t, ts.scrub(t, scope)]).toEqual([t, "A family member"]);
    // Off her photographs nothing is looked up inside it.
    expect(ts.scrub("#maddison", await forgottenScope({ photoIds: [(await mk("o")).id] }))).toBe("#maddison");
  });

  it("keeps somebody else's full name in a later answer on her photograph, as the forget does", async () => {
    const grace = await db.person.create({ data: { name: "Grace Hopper", createdById: admin } });
    await db.person.create({ data: { name: "Grace Kelly", createdById: admin } });
    const p = await mk("g", { annotation: record({ caption: "Grace Kelly and Grace" }), annotatedAt: new Date() });
    await tag(p.id, grace.id);
    await forgetPerson(grace.id, { keepName: false, byUserId: admin });
    expect(await caption(p.id)).toBe("Grace Kelly and a family member");
    const ts = await loadTombstone();
    const scope = await forgottenScope({ photoIds: [p.id] });
    expect(ts.scrub("Grace Kelly and Grace", scope)).toBe("Grace Kelly and a family member");
    // Not written as a name is, nor in a tag.
    expect(ts.scrub("grace kelly and Grace", scope)).toBe("A family member kelly and a family member");
  });

  it("parts two names joined only by a zero-width space in a later answer", async () => {
    const jordan = await db.person.create({ data: { name: "Jordan Lee", createdById: admin } });
    await db.person.create({ data: { name: "Tom Jordan", createdById: admin } });
    const p = await mk("z");
    await tag(p.id, jordan.id);
    await forgetPerson(jordan.id, { keepName: false, byUserId: admin });
    const ts = await loadTombstone();
    const scope = await forgottenScope({ photoIds: [p.id] });
    expect(ts.scrub("Tom\u200bJordan Lee", scope)).not.toMatch(/Jordan/u);
    expect(ts.scrub("Tom Jordan at the lake", scope)).toBe("Tom Jordan at the lake");
  });

  it("stamps the end of a forget that crashes at the very end", async () => {
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin } });
    await tag((await mk("a")).id, ada.id);
    crash.on = true;
    await expect(forgetPerson(ada.id, { keepName: false, byUserId: admin })).rejects.toThrow(/very end/u);
    const s = await db.appSetting.findUniqueOrThrow({ where: { id: "app" } });
    expect(crash.at).not.toBeNull();
    expect(s.lastForgetAt!.getTime()).toBeGreaterThanOrEqual(crash.at!.getTime());
  });
});
