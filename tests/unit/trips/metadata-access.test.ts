import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { resetTestDb } from "../helpers/reset";

vi.hoisted(() => { process.env.APP_URL = process.env.APP_URL || "https://album.example"; });
const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ SHARE_COOKIE_PREFIX: "share_", getViewer: async () => who.viewer }));

import { generateMetadata as tripMetadata } from "@/app/trips/[slug]/layout";
import { generateMetadata as collectionMetadata } from "@/app/collections/[slug]/layout";

const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });
const trip = (slug: string) => tripMetadata({ params: Promise.resolve({ slug }) } as never);
const collection = (slug: string) => collectionMetadata({ params: Promise.resolve({ slug }) } as never);

/** The tab title is written before the body sends a stranger to sign in, so it must not name what they cannot open. */
describe("a trip's or collection's title in the tab", () => {
  let member: Viewer, tripId: string, collectionId: string;
  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "jo@example.com", name: "Jo", role: "MEMBER" } });
    member = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
    tripId = (await db.trip.create({ data: { slug: "clinic", title: "Mum's clinic week", startDate: new Date("2025-03-01"), endDate: new Date("2025-03-03"), createdById: u.id, visibility: "PRIVATE" } })).id;
    collectionId = (await db.collection.create({ data: { slug: "scans", title: "Scan results", createdById: u.id, visibility: "PRIVATE" } })).id;
  });

  it("is generic for a stranger on a private trip or collection", async () => {
    who.viewer = anon();
    const t = await trip("clinic");
    const c = await collection("scans");
    expect(t.title).toBe("Trip");
    expect(c.title).toBe("Collection");
    expect(JSON.stringify([t, c])).not.toMatch(/clinic week|Scan results/);
  });

  it("is generic for a stranger on a link-only one without its cookie, and named for one holding it", async () => {
    await db.trip.update({ where: { id: tripId }, data: { visibility: "LINK", shareToken: "ttok" } });
    await db.collection.update({ where: { id: collectionId }, data: { visibility: "LINK", shareToken: "ctok" } });
    who.viewer = anon();
    expect((await trip("clinic")).title).toBe("Trip");
    expect((await collection("scans")).title).toBe("Collection");
    who.viewer = anon([[shareKey("trip", tripId), "ttok"], [shareKey("collection", collectionId), "ctok"]]);
    expect((await trip("clinic")).title).toBe("Mum's clinic week");
    expect((await collection("scans")).title).toBe("Scan results");
  });

  it("names it for a member, and for anybody when it is public", async () => {
    who.viewer = member;
    expect((await trip("clinic")).title).toBe("Mum's clinic week");
    expect((await collection("scans")).title).toBe("Scan results");
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PUBLIC" } });
    await db.collection.update({ where: { id: collectionId }, data: { visibility: "PUBLIC" } });
    who.viewer = anon();
    expect((await trip("clinic")).title).toBe("Mum's clinic week");
    expect((await collection("scans")).title).toBe("Scan results");
  });
});
