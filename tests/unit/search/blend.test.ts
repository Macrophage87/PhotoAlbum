import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { blendScore, KEYWORD_WEIGHT, searchMedia } from "@/lib/search/query";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const member: Viewer = { kind: "user", user: { id: "u", email: "u@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };

describe("blendScore", () => {
  it("weights keyword and semantic scores with one constant", () => {
    expect(KEYWORD_WEIGHT).toBe(0.7);
    expect(blendScore(1, 1, null)).toBeCloseTo(0.7);
    expect(blendScore(0, 1, 1)).toBeCloseTo(0.3);
    expect(blendScore(0.5, 1, 0.5)).toBeCloseTo(0.5);
  });
});

/**
 * The query test set: each query names the item expected in the top three. Keyword-only here (no sidecar in unit
 * tests); the constant may be changed only when this set motivates it.
 */
const ITEMS: { caption: string; context?: string; tags?: string[]; place?: string }[] = [
  { caption: "Lunch on the Ranger", context: "lobster rolls on the mail boat", tags: ["lobster", "boat", "harbour", "seafood"], place: "Bar Harbor" },
  { caption: "Sam's first swim at the lake house", tags: ["swimming", "lake", "child", "summer"], place: "Lake House" },
  { caption: "Eighth birthday cake", context: "Dad and the twins ice the cake, dog under the table", tags: ["birthday", "cake", "kitchen", "dog", "balloons"] },
  { caption: "Ocean Path hike", tags: ["hiking", "trail", "cliffs", "ocean", "acadia"], place: "Acadia" },
  { caption: "Christmas morning 1992", context: "scanned print, Nana's handwriting on the back", tags: ["christmas", "presents", "tree", "winter", "scan"] },
  { caption: "Sunset over the campsite", tags: ["camping", "tent", "sunset", "mountains", "campfire"] },
  { caption: "Biscuit in the snow", context: "the dog's first winter", tags: ["dog", "snow", "winter", "backyard"] },
  { caption: "Bike ride along the canal", tags: ["cycling", "bike", "canal", "helmet", "spring"] },
  { caption: "Kayaks at dawn", tags: ["kayaking", "paddle", "lake", "fog", "sunrise"] },
  { caption: "Grandma Jo's 80th", context: "everyone came to the lake house", tags: ["birthday", "party", "family", "cake", "eighty"] },
  { caption: "Pizza night", tags: ["pizza", "dinner", "kitchen", "friends"] },
  { caption: "Chickens in the run", tags: ["chickens", "hens", "coop", "garden", "eggs"] },
  { caption: "Skiing at Sugarloaf", tags: ["skiing", "snow", "mountain", "lift", "winter"] },
  { caption: "Road trip through the desert", tags: ["road trip", "desert", "car", "cactus", "sunny"] },
  { caption: "Graduation day", tags: ["graduation", "cap", "gown", "school", "family"] },
  { caption: "Halloween costumes", tags: ["halloween", "costume", "pumpkin", "autumn"] },
  { caption: "Fishing off the dock", tags: ["fishing", "dock", "rod", "lake", "morning"] },
  { caption: "Thanksgiving table", tags: ["thanksgiving", "turkey", "dinner", "family", "autumn"] },
  { caption: "Ice cream on the pier", tags: ["ice cream", "pier", "beach", "summer", "sea"] },
  { caption: "Kate's wedding", tags: ["wedding", "bride", "dance", "cake", "celebration"] },
  { caption: "Snowman in the garden", tags: ["snowman", "snow", "garden", "winter", "kids"] },
  { caption: "Coffee in Lisbon", tags: ["coffee", "cafe", "city", "travel", "lisbon"] },
  { caption: "Fireworks on the fourth", tags: ["fireworks", "july", "night", "celebration"] },
  { caption: "Picnic in the park", tags: ["picnic", "park", "blanket", "sandwiches", "spring"] },
  { caption: "The old station wagon", context: "scanned print, about 1978", tags: ["car", "vintage", "scan", "driveway"] },
];
const QUERIES: [string, string][] = [
  ["lobster", "Lunch on the Ranger"],
  ["seafood boat", "Lunch on the Ranger"],
  ["first swim", "Sam's first swim at the lake house"],
  ["birthday cake dog", "Eighth birthday cake"],
  ["hike cliffs", "Ocean Path hike"],
  ["christmas 1992", "Christmas morning 1992"],
  ["Nana handwriting", "Christmas morning 1992"],
  ["campfire sunset", "Sunset over the campsite"],
  ["dog snow", "Biscuit in the snow"],
  ["cycling canal", "Bike ride along the canal"],
  ["kayak fog", "Kayaks at dawn"],
  ["80th party", "Grandma Jo's 80th"],
  ["pizza", "Pizza night"],
  ["hens coop", "Chickens in the run"],
  ["skiing", "Skiing at Sugarloaf"],
  ["desert cactus", "Road trip through the desert"],
  ["graduation", "Graduation day"],
  ["halloween pumpkin", "Halloween costumes"],
  ["fishing dock", "Fishing off the dock"],
  ["thanksgiving turkey", "Thanksgiving table"],
  ["ice cream pier", "Ice cream on the pier"],
  ["wedding dance", "Kate's wedding"],
  ["snowman", "Snowman in the garden"],
  ["coffee lisbon", "Coffee in Lisbon"],
  ["fireworks", "Fireworks on the fourth"],
  ["picnic park", "Picnic in the park"],
  ["station wagon", "The old station wagon"],
  ["vintage car 1978", "The old station wagon"],
  ["lake house", "Sam's first swim at the lake house"],
  ["scanned print", "Christmas morning 1992"],
];

describe("the query test set", () => {
  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "q@example.com" } });
    for (const item of ITEMS) {
      await db.photo.create({
        data: { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", caption: item.caption, context: item.context, annotation: item.tags ? { caption: item.caption, description: "", tags: item.tags, place: item.place ?? null, activity: null, objects: [], visibleText: null, season: "unknown", mood: null, searchSummary: item.tags.join(" ") } : undefined },
      });
    }
  });
  it.each(QUERIES)("%s finds %s in the top three", async (q, expected) => {
    const hits = await searchMedia(member, { q }, 120, null);
    expect(hits.slice(0, 3).map((h) => h.caption)).toContain(expected);
  });
  it("uses a supplied embedding when the keyword side is empty", async () => {
    const zero = Array(384).fill(0);
    const hits = await searchMedia(member, { q: "zzzz" }, 120, async () => zero);
    expect(hits).toEqual([]); // no textEmbedding rows in this set, so nothing passes the semantic floor
  });
});
