import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import { thinkingParams } from "./client";

/**
 * What the helper may guess at, and what it must leave alone. Shared word for word by the full description request
 * and the place-only pass, so both are held to the same line: a place a stranger could name from the photo, never
 * someone's home.
 */
export const PLACE_RULES = `Estimating a place:
- Only when the text block says the item has no location and asks you to estimate one.
- Estimate only somewhere public and recognizable: a landmark or monument, a national or city park, a named beach, a harbour or waterfront, a plaza or square, a famous street or avenue, a stadium, a museum, a cathedral, a bridge, a ski resort, a well-known trail, or a region with a distinctive look (the Amalfi coast, Tuscany, the Scottish highlands). It does not have to be world-famous — the Inner Harbor in Baltimore, a state park, a college quad and a town's main street all count if the photo really shows which one it is.
- Somewhere private is different: a house, a garden or backyard, a driveway, a residential street, a block of flats, a school, a workplace, or the inside of a home. You may still say where these are, but only as far as the town or city — never the building, the street or the address. Set precision to "city", give the center of the town or city and a radius that covers it, and name it as a town ("Towson, Maryland"), never as an address. If you cannot tell the town either, but you can tell the wider area, use precision "region"; when you can tell neither, return null.
- Whatever you recognize, never work a location out from a house number, a name on a mailbox, a vehicle registration plate, a school uniform, or a delivery label, and never name the street a home is on. Those identify where a family lives, which is exactly what must not end up in the album.
- Never estimate from the people in the photo, and never from a photo that is mostly one person's face.
- Estimate from the place itself: the building, the skyline, the monument, the coastline, the signage, the landscape, the vegetation, the language on public signs. A place named in the notes, the title or the trip is good evidence and you should use it.
- precision says how closely you are placing it: "exact" for a public place you can point at, "city" for the town or city something sits in (always use this for somewhere private), "region" for a wider area.
- lat and lng are the center of what you recognized, in decimal degrees. radiusM says how tightly you can pin it: about 100 m for a monument you can stand in front of, 2000 m for a neighborhood or a park, 5000 m or more for a town or city, 50000 m or more for a region. Never give a small radius for a broad guess, and never a radius under 2000 m with precision "city".
- confidence is between 0 and 1 and means how sure you are of the place, not of the coordinates. Below about 0.5 the album throws the guess away, so an honest low number is better than a confident wrong one.
- evidence is one short sentence naming what you recognized ("the Domino Sugar sign across the water and the Inner Harbor pagoda"). It is shown to the family beside the pin, so it must be something they can check.
- evidence for a town-level answer must justify the town, not describe the house: "the mountains behind the houses and the Dutch street signs" is right, "the white house with the green door on Elm Street" is not. Never name the street, the block or the building a home is on, and never repeat a house number, even as evidence.
- When you cannot tell where it was at all, return null. A blank is always better than a guess. But a private place you can put in a town is not a blank: give the town.`;

/** One estimate: where the helper thinks this was taken, and why. */
export const placeEstimateSchema = z
  .object({
    name: z.string().max(120).describe("The place in words, as a person would say it: \"Inner Harbor, Baltimore\", \"Tuscany, Italy\". Never a street address."),
    precision: z.enum(["exact", "city", "region"]).describe("How closely it is being placed; always \"city\" or wider for somewhere private"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusM: z.number().int().min(50).max(300_000).describe("How tightly the place is pinned, in meters"),
    confidence: z.number().min(0).max(1),
    evidence: z.string().max(300).describe("One sentence naming what you recognized"),
  })
  .nullable();

export type PlaceEstimate = z.infer<typeof placeEstimateSchema>;

/** The place-only pass, for items already described before the album could estimate places. */
export const placeOnlySchema = z.object({ place: placeEstimateSchema.describe("The estimate, or null when the place is not recognizable or is private") });

export const PLACE_ONLY_INSTRUCTIONS = `You are placing photos and short video clips from a private family album on a map. The family has photos with no location recorded, and wants the recognizable ones pinned so they can be found on the map again.

You will receive one item at a time: the image (for a clip, a few frames in order), and a text block with whatever the family recorded about it: their notes, the date, the trip or collections it belongs to, and any place they have already written down.

${PLACE_RULES}

Write any words in American English, with American spelling.

Answer only with the structured record. Do not describe the photo.`;

/** Below this the guess is thrown away rather than shown: a pin nobody trusts is worse than no pin. */
export const MIN_PLACE_CONFIDENCE = 0.5;

/**
 * Floors for a coarse guess. Somewhere private is placed at its town and never tighter, so a photo of a back garden
 * can say "Towson, Maryland" without the pin ever landing on the house. The helper is asked for these radii and the
 * answer is clamped to them anyway, because this is the part that must not go wrong.
 */
export const CITY_RADIUS_M = 5_000;
export const REGION_RADIUS_M = 25_000;

/**
 * A named street, with or without a house number ("Elm Street", "12 Oak Rd"). A town-level answer must never carry
 * this much detail, in the name or in the evidence: the pin would be at the city while the words beside it said
 * exactly which house. Only ever applied to a coarse answer, so a public place really called Abbey Road is untouched.
 */
const NAMED_STREET = /\b(?:\d{1,5}[a-z]?\s+)?[A-Z\u00C0-\u00DE][\w\u00C0-\u00FF'\u2019-]*\s+(?:Street|Road|Avenue|Lane|Drive|Court|Boulevard|Crescent|Terrace|Close|Place|St|Rd|Ave|Ln|Dr|Ct|Blvd|Pl)\.?(?=\s|,|$)/;
const HOUSE_NUMBER = /^\s*\d{1,5}[a-z]?[\s,]+/i;

/**
 * Hold a town-level answer to the town. The name keeps only the parts that read as a place rather than an address,
 * and evidence that names a street is replaced rather than shown: the family still learns the pin is a guess and
 * roughly why, without the album recording where somebody lives. Returns null when nothing usable is left.
 */
export function scrubCoarsePlace(estimate: PlaceEstimate): PlaceEstimate {
  if (!estimate || estimate.precision === "exact") return estimate;
  const parts = estimate.name.split(",").map((p) => p.trim().replace(HOUSE_NUMBER, "")).filter((p) => p && !NAMED_STREET.test(p));
  const name = parts.join(", ");
  if (!name) return null;
  const evidence = NAMED_STREET.test(estimate.evidence) || HOUSE_NUMBER.test(estimate.evidence)
    ? "Placed at the town rather than the spot itself, which looks like somewhere private."
    : estimate.evidence;
  return { ...estimate, name, evidence };
}

/** Clamp a raw response to the schema's limits before validating, the way the description response is clamped. */
export function clampPlace(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const p = r.place;
  if (p && typeof p === "object") {
    const e = { ...(p as Record<string, unknown>) };
    if (typeof e.name === "string") e.name = e.name.slice(0, 120);
    if (typeof e.evidence === "string") e.evidence = e.evidence.slice(0, 300);
    if (typeof e.radiusM === "number") e.radiusM = Math.min(300_000, Math.max(50, Math.round(e.radiusM)));
    // A private place is placed at its town, so the pin must cover the town however tight the helper wanted to be.
    if (typeof e.radiusM === "number") e.radiusM = Math.max(e.radiusM, e.precision === "city" ? CITY_RADIUS_M : e.precision === "region" ? REGION_RADIUS_M : 0);
    r.place = e;
  }
  return r;
}

/** Validate a place-only batch result by hand, since `parse` does not apply to batch results. */
export function parsePlaceContent(content: { type: string; text?: string }[]): PlaceEstimate | null | undefined {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    const result = placeOnlySchema.safeParse(clampPlace(JSON.parse(text)));
    return result.success ? result.data.place : undefined;
  } catch {
    return undefined;
  }
}

/** The request for the place-only pass. Separate from file reading so the parameters are unit-tested. */
export function placeRequestParams(model: string, images: Anthropic.ImageBlockParam[], text: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 2000,
    ...thinkingParams(model),
    system: [{ type: "text", text: PLACE_ONLY_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...images, { type: "text", text }] }],
    output_config: { ...thinkingParams(model).output_config, format: zodOutputFormat(placeOnlySchema) },
  };
}

/** Whether an item still wants a guess: nothing in it says where it was, and nobody has asked yet. */
export function needsPlaceEstimate(item: { lat: number | null; placeEstimatedAt: Date | null }): boolean {
  return item.lat === null && item.placeEstimatedAt === null;
}

/**
 * Record that a place pass finished badly. A terminal failure (a refusal, output nobody can read) stamps the ask so
 * the item is not sent again; a transport failure leaves it eligible for the next run. Nothing about the item's
 * description is touched: a place run has nothing to say about it.
 */
export async function recordPlaceFailure(photoId: string, opts: { terminal?: boolean } = {}): Promise<void> {
  if (opts.terminal === false) return;
  await db.photo.update({ where: { id: photoId }, data: { placeEstimatedAt: new Date() } }).catch(() => {});
}

/**
 * Record a guess. It is only ever written where the album has no position of its own, so a place a member set, one
 * from the camera, from a track or from a Google sidecar always wins; a track imported afterwards replaces it in
 * turn (see geotag-photos). placeEstimatedAt is stamped either way, so a declined item is not asked about again.
 */
export async function applyPlaceEstimate(photoId: string, estimate: PlaceEstimate): Promise<"placed" | "declined" | "skipped"> {
  const current = await db.photo.findUnique({ where: { id: photoId }, select: { lat: true, gpsSource: true } });
  if (!current) return "skipped";
  // A town-level answer is held to the town before anything is written, name and evidence alike.
  const place = estimate && estimate.confidence >= MIN_PLACE_CONFIDENCE ? scrubCoarsePlace(estimate) : null;
  const free = current.lat === null && (current.gpsSource === null || current.gpsSource === "ESTIMATE");
  if (!place || !free) {
    await db.photo.update({ where: { id: photoId }, data: { placeEstimatedAt: new Date() } });
    return place ? "skipped" : "declined";
  }
  await db.photo.update({
    where: { id: photoId },
    data: {
      lat: place.lat,
      lng: place.lng,
      gpsSource: "ESTIMATE",
      placeEstimateName: place.name,
      placeEstimateConfidence: place.confidence,
      placeEstimateRadiusM: place.radiusM,
      placeEstimatePrecision: place.precision === "city" ? "CITY" : place.precision === "region" ? "REGION" : "EXACT",
      placeEstimateNote: place.evidence,
      placeEstimatedAt: new Date(),
    },
  });
  return "placed";
}
