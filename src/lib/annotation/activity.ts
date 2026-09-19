import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { formatDateTime, formatDistance, formatDuration, formatLocalTime } from "@/lib/time/format";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { notOptedOutWhere } from "./eligibility";
import { thinkingParams } from "./client";

/** How many of an activity's photographs are sent. Enough to see how the day went; not the whole roll. */
export const ACTIVITY_FRAMES = 8;

export const activityDescriptionSchema = z.object({
  description: z.string().max(1200).describe("Two to five sentences about the outing as a whole: where it went, what happened, how it felt"),
});

export type ActivityDescription = z.infer<typeof activityDescriptionSchema>;

/**
 * Instructions for describing an outing rather than a single photograph.
 *
 * The same discipline about names as everywhere else: use the ones you are given and no others. The difference is
 * the subject — this is a paragraph about a walk, a ride or an afternoon, written from a handful of its
 * photographs and whatever the track recorded, and it is read under the activity's own title.
 */
export const ACTIVITY_INSTRUCTIONS = `You write a short description of one outing for a private family photo album: a walk, a ride, a paddle, a drive, an afternoon out. The family reads it under the outing's own title, and searches it later.

You will receive a few photographs taken on the outing, in the order they were taken, and a text block with what the album knows: the title the family gave it, what kind of outing it was, when it happened and how long it took, the trip it belongs to, whatever a recorded track measured, and the captions the family or the album already wrote for those photographs.

Rules:
- Write two to five sentences about the outing as a whole, not a list of the photographs. Say where it went, what happened along the way, and how it felt.
- Use the numbers from the track when they are given and say something a person would say — "four and a half miles along the shore" rather than "distance: 7.2 km" — and only when they add to the description. Never invent a distance, a climb or a duration that you were not given.
- Use a person's name only when it is given to you in the text block, and when names are given, use them rather than age or role words. Somebody with no name given is "a child", "a family member", and so on.
- Trust the existing captions over your own reading of the pictures; they come from people who were there.
- When a note from the family is included, it outranks your own reading of the photographs: they were there and you were not. Use what it tells you — where it went, who was there, what happened, what it was for — and fill in around it. Keep its facts; you need not keep its words.
- Do not describe anyone's body, health or ethnicity, or anything a family would find unkind to read under their own photographs.
- Never invent a place or an occasion that is neither visible nor in what you were given. Anything you cannot determine, leave out rather than guessing.
- Plain, warm, specific. No stock-photo language, and do not start with "This photo" or "This activity".

Answer only with the structured record.`;

type ActivityForDescription = NonNullable<Awaited<ReturnType<typeof loadActivityForDescription>>>;

/** The activity, its track's figures, and the photographs that may be sent — those not opted out, oldest first. */
export async function loadActivityForDescription(activityId: string) {
  const notOptedOut: Prisma.PhotoWhereInput = { ...notOptedOutWhere, OR: [...notOptedOutWhere.OR] };
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      title: true,
      type: true,
      startTime: true,
      endTime: true,
      description: true,
      trip: { select: { id: true, title: true, timezone: true, annotationOptOut: true } },
      track: { select: { stats: true } },
    },
  });
  if (!activity) return null;
  const photos = await db.photo.findMany({
    // Spread through a mutable copy: the shared clause is `as const`, and Prisma's OR wants a mutable array.
    where: { activityId, ...NOT_TRASHED, status: "READY", ...notOptedOut },
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
    take: ACTIVITY_FRAMES,
    select: { id: true, renditions: true, caption: true, title: true, context: true },
  });
  return { ...activity, photos };
}

/**
 * The text block: the title, the clock, the track's figures, what the family already wrote on the pictures, and
 * whatever the person pressing the button typed into the box before they pressed it.
 *
 * That last part is the one thing photographs cannot supply — that it was somebody's birthday, that the wind was
 * the whole story, that the point of the walk was the ice cream at the end. It goes in late and marked as coming
 * from someone who was there, so the helper builds around it rather than arguing with it.
 */
export function describeActivityItem(activity: ActivityForDescription, permittedNames: string[], note?: string): string {
  const tz = activity.trip.timezone;
  const lines: string[] = [];
  lines.push(`Outing: ${ACTIVITY_LABEL[activity.type] ?? "outing"} titled "${activity.title}"`);
  lines.push(`Trip: ${activity.trip.title}`);
  lines.push(`When: ${formatDateTime(activity.startTime, tz, "EEEE, MMMM d, yyyy")}, ${formatLocalTime(activity.startTime, { timezone: tz })} to ${formatLocalTime(activity.endTime, { timezone: tz })}`);
  const stats = activity.track?.stats;
  if (stats) {
    const figures: string[] = [];
    if (stats.distanceM) figures.push(`distance ${formatDistance(stats.distanceM)}`);
    if (stats.movingTimeS) figures.push(`moving for ${formatDuration(stats.movingTimeS)}`);
    if (stats.elevGainM) figures.push(`${Math.round(stats.elevGainM * 3.28084)} ft of climbing`);
    if (stats.avgHr) figures.push(`average heart rate ${Math.round(stats.avgHr)}`);
    if (figures.length) lines.push(`The track recorded: ${figures.join(", ")}.`);
  }
  const written = activity.photos.map((p) => [p.title, p.caption, p.context].filter(Boolean).join(" — ")).filter(Boolean);
  if (written.length) lines.push(`What the album already says about these photographs, in order:\n${written.map((w) => `- ${w}`).join("\n")}`);
  lines.push(
    permittedNames.length
      ? `People confirmed in these photographs — call them by these names rather than by age or role: ${permittedNames.join(", ")}`
      : "No people have been confirmed in these photographs; do not name anyone unless the captions do.",
  );
  if (activity.description) lines.push(`There is already a description, which you are being asked to replace:\n${activity.description}`);
  const said = note?.trim();
  if (said) lines.push(`A note from the family, written by somebody who was there. Treat what it says as true:\n${said}`);
  return lines.join("\n");
}

/** Read the answer back, or null when it is not the record that was asked for. */
export function parseActivityDescription(content: { type: string; text?: string }[]): ActivityDescription | null {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    const result = activityDescriptionSchema.safeParse(JSON.parse(text));
    return result.success && result.data.description.trim() ? result.data : null;
  } catch {
    return null;
  }
}

/** Build the request. Images come from the local renditions of the activity's own photographs; nothing is fetched. */
export async function buildActivityRequest(activity: ActivityForDescription, model: string, permittedNames: string[], note?: string): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  const store = storage();
  const images: Anthropic.ImageBlockParam[] = [];
  for (const p of activity.photos) {
    const medium = (p.renditions as Renditions | null)?.medium;
    if (!medium) continue;
    const buf = await readFile(store.localPath!(medium.key));
    images.push({ type: "image", source: { type: "base64", media_type: "image/webp", data: buf.toString("base64") } });
  }
  return {
    model,
    max_tokens: 2000,
    ...thinkingParams(model),
    system: [{ type: "text", text: ACTIVITY_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...images, { type: "text", text: describeActivityItem(activity, permittedNames, note) }] }],
    output_config: { ...thinkingParams(model).output_config, format: zodOutputFormat(activityDescriptionSchema) },
  };
}
