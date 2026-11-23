import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const jar = vi.hoisted(() => ({ values: new Map<string, string>(), viewer: null as unknown as Viewer }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    getAll: () => [],
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => jar.viewer }));

import { LARGE_TEXT_COOKIE, wantsLargeText } from "@/lib/reading/large-text";
import { setLargeText } from "@/app/reading/actions";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

describe("larger text and stronger contrast", () => {
  beforeEach(async () => {
    await resetTestDb();
    jar.values.clear();
  });

  it("is kept in the browser for a visitor", async () => {
    jar.viewer = anon;
    expect(await wantsLargeText(anon)).toBe(false);
    await setLargeText(true);
    expect(jar.values.get(LARGE_TEXT_COOKIE)).toBe("1");
    expect(await wantsLargeText(anon)).toBe(true);
    await setLargeText(false);
    expect(await wantsLargeText(anon)).toBe(false);
  });

  it("is kept on a member's account, so it follows them to every device", async () => {
    const u = await db.user.create({ data: { email: "jo@example.com", name: "Jo" } });
    jar.viewer = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER", largeText: false }, shareTokens: new Map() };
    await setLargeText(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).largeText).toBe(true);
    // Another device, where this browser never chose: the account decides.
    jar.values.clear();
    expect(await wantsLargeText({ ...jar.viewer, user: { ...jar.viewer.user!, largeText: true } } as Viewer)).toBe(true);
    // Turned off elsewhere, a cookie left behind here does not overrule the account.
    jar.values.set(LARGE_TEXT_COOKIE, "1");
    expect(await wantsLargeText({ ...jar.viewer, user: { ...jar.viewer.user!, largeText: false } } as Viewer)).toBe(false);
  });
});
