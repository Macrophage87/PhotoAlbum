import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { permittedNames } from "@/lib/people/gates";
import { annotationGates, notOptedOutWhere } from "./eligibility";
import { anthropic, thinkingParams } from "./client";
import { activityDescriptionSchema, parseActivityDescription, type ActivityDescription } from "./activity";

/** A trip or a gathering; an activity has its own module, because a walk has figures and a fortnight has days. */
export type ContainerKind = "trip" | "collection";

/**
 * How many photographs are sent. More than an activity gets, because the point is the shape of the whole thing
 * rather than one afternoon, and still nothing like all of them: a fortnight has hundreds and ten spread across it
 * say more about it than ten consecutive ones from the first morning.
 */
export const CONTAINER_FRAMES = 12;

/** The same one-paragraph record an activity's description uses. What is being described differs; the answer does not. */
export const containerDescriptionSchema = activityDescriptionSchema;
export type ContainerDescription = ActivityDescription;

export const CONTAINER_INSTRUCTIONS = `You write a short description of one trip or one collection for a private family photo album. The family reads it under the title, at the top of every page of that trip or collection, and searches it later.

You will receive a handful of photographs from it, spread across the whole of it rather than taken together, and a text block with what the album knows: what kind of thing it is, the title the family gave it, when it was, how many photographs are in it, what the outings in it were called, and the captions the family or the album already wrote for the photographs you are shown.

Rules:
- Write two to five sentences about the whole of it. For a trip: where it was, roughly when, what the days were spent doing, how it felt. For a collection: what ties these photographs together, and what somebody opening it will find.
- You are shown a few photographs out of many. Describe what the whole thing seems to be, not the handful you were given, and never imply that what you were shown is all there is.
- Use a person's name only when it is given to you in the text block, and when names are given, use them rather than age or role words. Somebody with no name given is "a child", "a family member", and so on.
- Trust the existing captions over your own reading of the pictures; they come from people who were there.
- When a note from the family is included, it outranks your own reading of the photographs: they were there and you were not. Use what it tells you and fill in around it. Keep its facts; you need not keep its words.
- Do not describe anyone's body, health or ethnicity, or anything a family would find unkind to read under their own photographs.
- Never invent a place, an occasion or a date that is neither visible nor in what you were given. Anything you cannot determine, leave out rather than guessing.
- Plain, warm, specific. No stock-photo language, and do not start with "This trip", "This collection" or "This photo".

Answer only with the structured record.`;

export type ContainerForDescription = NonNullable<Awaited<ReturnType<typeof loadContainerForDescription>>>;

/** Evenly spaced across the whole thing, so a fortnight is not described from its first morning. */
function spread<T>(all: T[], take: number): T[] {
  if (all.length <= take) return all;
  const step = (all.length - 1) / (take - 1);
  return Array.from({ length: take }, (_, i) => all[Math.round(i * step)]);
}

/**
 * The container, what the album knows about it, and the photographs that may be sent.
 *
 * Two queries rather than one, and on purpose: the first asks which photographs are eligible at all, in order, and
 * the second reads only the dozen picked out of that list. Taking the first dozen instead would describe a
 * fortnight from the morning everybody arrived.
 */
export async function loadContainerForDescription(kind: ContainerKind, id: string) {
  // Spread through a mutable copy: the shared clause is `as const`, and Prisma's OR wants a mutable array.
  const notOptedOut: Prisma.PhotoWhereInput = { ...notOptedOutWhere, OR: [...notOptedOutWhere.OR] };
  const where: Prisma.PhotoWhereInput =
    kind === "trip" ? { tripId: id, ...NOT_TRASHED, status: "READY", ...notOptedOut } : { collections: { some: { collectionId: id } }, ...NOT_TRASHED, status: "READY", ...notOptedOut };

  const container =
    kind === "trip"
      ? await db.trip.findUnique({
          where: { id },
          select: { id: true, title: true, description: true, annotationOptOut: true, startDate: true, endDate: true, _count: { select: { photos: { where: NOT_TRASHED } } }, activities: { orderBy: { startTime: "asc" }, take: 20, select: { title: true } } },
        })
      : await db.collection.findUnique({
          where: { id },
          select: { id: true, title: true, description: true, annotationOptOut: true, _count: { select: { items: true } } },
        });
  if (!container) return null;

  const eligible = await db.photo.findMany({ where, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: { id: true } });
  const picked = spread(eligible, CONTAINER_FRAMES).map((p) => p.id);
  const photos = picked.length
    ? await db.photo.findMany({ where: { id: { in: picked } }, orderBy: [{ takenAt: "asc" }, { id: "asc" }], select: { id: true, renditions: true, caption: true, title: true, context: true } })
    : [];
  const dates = "startDate" in container ? { start: container.startDate, end: container.endDate } : null;
  const activities = "activities" in container ? container.activities.map((a) => a.title) : [];
  const count = "photos" in container._count ? container._count.photos : container._count.items;
  return { kind, id: container.id, title: container.title, description: container.description, annotationOptOut: container.annotationOptOut, dates, activities, count, photos };
}

/** The text block: what it is, when it was, how big it is, what happened in it, and what the family already wrote. */
export function describeContainerItem(container: ContainerForDescription, permittedNames: string[], note?: string): string {
  const lines: string[] = [];
  lines.push(`${container.kind === "trip" ? "Trip" : "Collection"}: "${container.title}"`);
  if (container.dates) lines.push(`When: ${formatDayRange(dateColumnToDay(container.dates.start), dateColumnToDay(container.dates.end))}`);
  lines.push(`It holds ${container.count} photograph${container.count === 1 ? "" : "s"}; you are being shown ${container.photos.length} of them, spread across the whole of it.`);
  if (container.activities.length) lines.push(`The outings the family recorded in it: ${container.activities.join(", ")}`);
  const written = container.photos.map((p) => [p.title, p.caption, p.context].filter(Boolean).join(" — ")).filter(Boolean);
  if (written.length) lines.push(`What the album already says about the photographs you were shown, in order:\n${written.map((w) => `- ${w}`).join("\n")}`);
  lines.push(
    permittedNames.length
      ? `People confirmed in these photographs — call them by these names rather than by age or role: ${permittedNames.join(", ")}`
      : "No people have been confirmed in these photographs; do not name anyone unless the captions do.",
  );
  if (container.description) lines.push(`There is already a description, which you are being asked to replace:\n${container.description}`);
  const said = note?.trim();
  if (said) lines.push(`A note from the family, written by somebody who was there. Treat what it says as true:\n${said}`);
  return lines.join("\n");
}

/** Build the request. Images come from the local renditions of its own photographs; nothing is fetched. */
export async function buildContainerRequest(container: ContainerForDescription, model: string, permittedNames: string[], note?: string): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  const store = storage();
  const images: Anthropic.ImageBlockParam[] = [];
  for (const p of container.photos) {
    const medium = (p.renditions as Renditions | null)?.medium;
    if (!medium) continue;
    const buf = await readFile(store.localPath!(medium.key));
    images.push({ type: "image", source: { type: "base64", media_type: "image/webp", data: buf.toString("base64") } });
  }
  return {
    model,
    max_tokens: 2000,
    ...thinkingParams(model),
    system: [{ type: "text", text: CONTAINER_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...images, { type: "text", text: describeContainerItem(container, permittedNames, note) }] }],
    output_config: { ...thinkingParams(model).output_config, format: zodOutputFormat(containerDescriptionSchema) },
  };
}

/**
 * Ask the helper to write a trip's or a collection's description, and keep what it says.
 *
 * The same rules as everywhere else: nothing goes if the helper is switched off, an opted-out container is
 * refused outright, opted-out photographs are never among the ones sent, and only names the family has agreed to
 * are given. Called from a server action that has already established that this viewer may arrange the thing.
 */
export async function writeContainerDescription(kind: ContainerKind, id: string, note?: string): Promise<string> {
  const gates = await annotationGates();
  if (!gates.active) throw new Error("The AI helper is off");
  const container = await loadContainerForDescription(kind, id);
  if (!container) throw new Error("Not found");
  if (container.annotationOptOut) throw new Error(`${container.title} is opted out of the AI helper`);
  if (!container.photos.length) throw new Error(`There are no photographs in this ${kind} to describe it from`);

  const names = [...new Set((await Promise.all(container.photos.map((p) => permittedNames(p.id)))).flat())];
  const request = await buildContainerRequest(container, gates.model, names, note?.trim() || undefined);
  const response = await anthropic().messages.create(request);
  console.log(`[annotate-${kind}] ${container.id} model=${response.model} stop=${response.stop_reason} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  if (response.stop_reason === "refusal") throw new Error("The helper declined to describe this one");
  const parsed = parseActivityDescription(response.content as { type: string; text?: string }[]);
  if (!parsed) throw new Error("The helper's answer could not be read; try again");
  if (kind === "trip") await db.trip.update({ where: { id }, data: { description: parsed.description } });
  else await db.collection.update({ where: { id }, data: { description: parsed.description } });
  return parsed.description;
}
