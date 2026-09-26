import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const env = vi.hoisted(() => ({ NODE_ENV: "test" as string, FORGET_KEY: undefined as string | undefined }));
vi.mock("@/lib/env", async (orig) => {
  const actual = await orig<typeof import("@/lib/env")>();
  return { ...actual, env: () => ({ ...actual.env(), ...env }) };
});

import { assertCanForget, forgetKeyState, forgottenScope, loadTombstone, rememberForgotten } from "@/lib/people/tombstone";
import { unpermittedNameScrub } from "@/lib/people/unpermitted";
import { completePendingForgets } from "@/lib/people/forget-person";
import { annotationGates } from "@/lib/annotation/eligibility";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("the key forgotten names are hashed under", () => {
  beforeEach(async () => {
    await resetTestDb();
    env.NODE_ENV = "test";
    env.FORGET_KEY = undefined;
  });

  it("comes from FORGET_KEY and this install's salt, and is never stored", async () => {
    env.FORGET_KEY = KEY;
    const state = await forgetKeyState();
    expect(state.problem).toBeNull();
    expect(state.write?.version).toBe(1);
    await rememberForgotten([{ form: "Timothy Kent", capitalizedOnly: false }]);
    // The salt is in the database; the key made with it is not.
    const setting = await db.appSetting.findUniqueOrThrow({ where: { id: "app" } });
    expect(setting.forgetKey).not.toBeNull();
    expect(Buffer.from(setting.forgetKey!, "base64").equals(state.write!.key)).toBe(false);
    expect((await db.forgottenName.findFirstOrThrow()).keyVersion).toBe(1);
    expect((await loadTombstone()).scrub("Timothy Kent waved")).toBe("A family member waved");
  });

  it("outside production stands in with a key made from the database, and says so", async () => {
    const state = await forgetKeyState();
    expect(state.write?.version).toBe(0);
    expect(state.problem).toMatch(/FORGET_KEY is not set/);
    expect(state.paused).toBe(false);
  });

  it("in production, never set, refuses to forget but leaves the helper running", async () => {
    env.NODE_ENV = "production";
    await expect(assertCanForget()).rejects.toThrow(/paused/);
    const gates = await annotationGates();
    expect(gates.pausedForForgetKey).toBe(false);
  });

  it("still recognises names forgotten before it was set, and counts them for admins", async () => {
    await rememberForgotten([{ form: "Timothy Kent", capitalizedOnly: false }]);
    env.FORGET_KEY = KEY;
    await rememberForgotten([{ form: "Ada Byron", capitalizedOnly: false }]);
    const state = await forgetKeyState();
    expect(state.weak).toBe(1);
    expect(state.problem).toMatch(/1 forgotten name was kept before FORGET_KEY was set/);
    expect(state.paused).toBe(false);
    expect((await loadTombstone()).scrub("Timothy Kent went fishing with Ada Byron")).toBe("A family member went fishing with a family member");
  });

  it("once names are hashed under it, missing or changed pauses forgetting and the helper everywhere", async () => {
    env.FORGET_KEY = KEY;
    await rememberForgotten([{ form: "Timothy Kent", capitalizedOnly: false }]);
    // Not production: a worker started by hand without the key is caught all the same.
    env.FORGET_KEY = undefined;
    expect(await forgetKeyState()).toMatchObject({ paused: true, write: null });
    await expect(assertCanForget()).rejects.toThrow(/paused/);
    expect(await annotationGates()).toMatchObject({ active: false, pausedForForgetKey: true });
    env.FORGET_KEY = Buffer.alloc(32, 9).toString("base64");
    const state = await forgetKeyState();
    expect(state.problem).toMatch(/has changed/);
    expect(state.paused).toBe(true);
    env.FORGET_KEY = KEY;
    expect((await forgetKeyState()).paused).toBe(false);
  });

  it("refuses a FORGET_KEY that is not 32 bytes of base64, and takes one that is", async () => {
    env.NODE_ENV = "production";
    env.FORGET_KEY = "e2e-forget-key-not-a-secret";
    const bad = await forgetKeyState();
    expect(bad.write).toBeNull();
    expect(bad.invalid).toBe(true);
    expect(bad.problem).toMatch(/set but not valid/);
    await expect(assertCanForget()).rejects.toThrow(/paused/);
    env.FORGET_KEY = KEY;
    const good = await forgetKeyState();
    expect(good.write?.version).toBe(1);
    expect(good.invalid).toBe(false);
    expect(good.problem).toBeNull();
  });

  it("never falls back to the stand-in key for an invalid FORGET_KEY, outside production too", async () => {
    env.NODE_ENV = "development";
    env.FORGET_KEY = "e2e-forget-key-not-a-secret";
    const state = await forgetKeyState();
    expect(state.write).toBeNull();
    expect(state.problem).toMatch(/set but not valid/);
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const p = await db.person.create({ data: { name: "Timothy Kent", forgetPendingAt: new Date(), optedOutAt: new Date(), createdById: admin } });
    expect(await completePendingForgets()).toBe(0);
    expect(await db.person.findUnique({ where: { id: p.id } })).not.toBeNull();
    expect(await db.forgottenName.count()).toBe(0);
  });

  it("recognises a name forgotten before FORGET_KEY was set and again after, on both people's photographs", async () => {
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const photo = async () => (await db.photo.create({ data: { uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    const byron = await photo();
    const stone = await photo();
    // Under the stand-in key first, then under FORGET_KEY.
    await rememberForgotten([{ form: "Ada", capitalizedOnly: true, derived: true, kinship: ["Grandma"] }], { photoIds: [byron], taggedPhotoIds: [byron] });
    env.FORGET_KEY = KEY;
    await rememberForgotten([{ form: "Ada", capitalizedOnly: true, derived: true }], { photoIds: [stone], taggedPhotoIds: [stone] });
    const ts = await loadTombstone();
    expect(ts.scrub("Ada smiles", await forgottenScope({ photoIds: [stone] }, ts))).toBe("A family member smiles");
    expect(ts.scrub("Grandma Ada smiles", await forgottenScope({ photoIds: [byron] }, ts))).toBe("A family member smiles");
    expect((await unpermittedNameScrub([stone]))("Ada smiles")).toBe("A family member smiles");
    expect((await unpermittedNameScrub([byron]))("Ada smiles")).toBe("A family member smiles");
  });
});
