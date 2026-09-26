import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const env = vi.hoisted(() => ({ NODE_ENV: "test" as string, FORGET_KEY: undefined as string | undefined }));
vi.mock("@/lib/env", async (orig) => {
  const actual = await orig<typeof import("@/lib/env")>();
  return { ...actual, env: () => ({ ...actual.env(), ...env }) };
});

import { assertCanForget, forgetKeyState, loadTombstone, rememberForgotten } from "@/lib/people/tombstone";
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
    expect(state.version).toBe(1);
    await rememberForgotten([{ form: "Timothy Kent", capitalizedOnly: false }]);
    // The salt is in the database; the key made with it is not.
    const setting = await db.appSetting.findUniqueOrThrow({ where: { id: "app" } });
    expect(setting.forgetKey).not.toBeNull();
    expect(Buffer.from(setting.forgetKey!, "base64").equals(state.key!)).toBe(false);
    expect((await db.forgottenName.findFirstOrThrow()).keyVersion).toBe(1);
    expect((await loadTombstone()).scrub("Timothy Kent waved")).toBe("A family member waved");
  });

  it("outside production stands in with a key in the database, and says so", async () => {
    const state = await forgetKeyState();
    expect(state.key).not.toBeNull();
    expect(state.problem).toMatch(/FORGET_KEY is not set/);
    expect(state.paused).toBe(false);
  });

  it("in production, missing, refuses to forget and pauses the helper", async () => {
    env.NODE_ENV = "production";
    await expect(assertCanForget()).rejects.toThrow(/paused/);
    const gates = await annotationGates();
    expect(gates).toMatchObject({ active: false, pausedForForgetKey: true });
  });

  it("changed, is noticed, and names hashed under the old one are not used", async () => {
    env.FORGET_KEY = KEY;
    await rememberForgotten([{ form: "Timothy Kent", capitalizedOnly: false }]);
    env.FORGET_KEY = Buffer.alloc(32, 9).toString("base64");
    env.NODE_ENV = "production";
    const state = await forgetKeyState();
    expect(state.problem).toMatch(/has changed/);
    expect(state.paused).toBe(true);
  });
});
