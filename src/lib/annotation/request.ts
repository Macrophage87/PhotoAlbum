import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import type { VideoRenditions } from "@/lib/jobs/handlers/transcode-video";
import { ffmpeg } from "@/lib/video/ffmpeg";
import { formatDateTime } from "@/lib/time/format";
import { SYSTEM_INSTRUCTIONS } from "./prompt";
import { annotationSchema } from "./schema";
import { thinkingParams } from "./client";
import { needsPlaceEstimate, placeRequestParams } from "./place";
import { isWeakDate } from "@/lib/photos/date-from-neighbours";

export type ItemForAnnotation = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

export async function loadItem(photoId: string) {
  return db.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true, kind: true, status: true, storageKey: true, renditions: true, videoRenditions: true, takenAt: true, takenAtSource: true, tzOffsetMin: true, camera: true, lat: true, lng: true, placeEstimatedAt: true, context: true, caption: true, title: true, durationS: true,
      trip: { select: { title: true, timezone: true } },
      collections: { select: { collection: { select: { title: true } } } },
    },
  });
}

type ImageBlock = Anthropic.ImageBlockParam;

function imageBlock(buf: Buffer, mediaType: "image/webp" | "image/jpeg"): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } };
}

/** Frames at 25, 50 and 75 percent of a clip, as JPEG buffers. */
async function clipFrames(mp4Key: string, durationS: number | null): Promise<Buffer[]> {
  const store = storage();
  const input = store.localPath?.(mp4Key);
  if (!input) return [];
  const work = await mkdtemp(path.join(tmpdir(), "frames-"));
  try {
    const frames: Buffer[] = [];
    // Without a known duration every fraction would be the same first frame: send one.
    const d = durationS ?? 0;
    for (const fraction of d > 0 ? [0.25, 0.5, 0.75] : [0]) {
      const out = path.join(work, `f${fraction}.jpg`);
      await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", (d * fraction).toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", out]);
      frames.push(await readFile(out));
    }
    return frames;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The text block: everything the family recorded, plus the names it is permitted to use. */
export function describeItem(item: ItemForAnnotation, permittedNames: string[], askForDate: boolean, askForPlace = false): string {
  const lines: string[] = [];
  lines.push(item.kind === "VIDEO" ? "Item: a short video clip, shown as frames in time order." : item.kind === "EXTERNAL_VIDEO" ? "Item: the poster frame of a longer video." : "Item: a photo.");
  if (item.context) lines.push(`Notes from the person who uploaded it: ${item.context}`);
  if (item.caption) lines.push(`Existing caption: ${item.caption}`);
  if (item.title) lines.push(`Title: ${item.title}`);
  if (item.takenAt && !askForDate) lines.push(`Taken: ${formatDateTime(item.takenAt, item.trip?.timezone ?? "UTC", "EEEE, MMMM d, yyyy")}`);
  if (item.camera) lines.push(`Camera: ${item.camera}`);
  if (item.trip) lines.push(`Trip: ${item.trip.title}`);
  if (item.collections.length) lines.push(`Collections: ${item.collections.map((c) => c.collection.title).join(", ")}`);
  // Not "names you may use": permission alone got descriptions of the family's parents that still read "an older
  // couple", because a rule that allows a name does not ask for one.
  lines.push(
    permittedNames.length
      ? `People confirmed in this item — call them by these names rather than by age or role: ${permittedNames.join(", ")}`
      : "No people have been confirmed in this item; do not name anyone unless the notes do.",
  );
  if (askForDate) lines.push("This item has no reliable date. Please estimate a year range in estimatedYear using the notes and visible cues.");
  if (askForPlace) lines.push("This item has no location recorded. If it shows a public place you recognise, please estimate it; if it shows somewhere private, or nowhere you can name, leave it null.");
  return lines.join("\n");
}

/** Whether an item needs a date estimate: it has no trustworthy time of capture. */
export function needsDateEstimate(item: Pick<ItemForAnnotation, "takenAt" | "takenAtSource">): boolean {
  return isWeakDate(item.takenAtSource, item.takenAt);
}

/** The frames to send for one item: its medium rendition, plus three frames for a clip. Nothing else is fetched. */
async function itemImages(item: ItemForAnnotation): Promise<ImageBlock[]> {
  const store = storage();
  const images: ImageBlock[] = [];
  const medium = (item.renditions as Renditions | null)?.medium;
  if (medium) images.push(imageBlock(await readFile(store.localPath!(medium.key)), "image/webp"));
  const video = item.videoRenditions as VideoRenditions | null;
  if (item.kind === "VIDEO" && video?.mp4) for (const f of await clipFrames(video.mp4.key, item.durationS)) images.push(imageBlock(f, "image/jpeg"));
  if (!images.length) throw new Error("no rendition to send");
  return images;
}

/** Build the Messages request for one item. Images come from local renditions; nothing else is fetched. */
export async function buildRequest(item: ItemForAnnotation, model: string, permittedNames: string[]): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  const images = await itemImages(item);
  return requestParams(model, images, describeItem(item, permittedNames, needsDateEstimate(item), needsPlaceEstimate(item)));
}

/** The place-only pass: the same frames, a much smaller question, for items described before places were estimated. */
export async function buildPlaceRequest(item: ItemForAnnotation, model: string): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  const images = await itemImages(item);
  return placeRequestParams(model, images, describePlaceItem(item));
}

/** The text block for the place-only pass: what the family wrote, with no mention of people. */
export function describePlaceItem(item: ItemForAnnotation): string {
  const lines: string[] = [];
  lines.push(item.kind === "VIDEO" ? "Item: a short video clip, shown as frames in time order." : item.kind === "EXTERNAL_VIDEO" ? "Item: the poster frame of a longer video." : "Item: a photo.");
  if (item.context) lines.push(`Notes from the person who uploaded it: ${item.context}`);
  if (item.caption) lines.push(`Existing caption: ${item.caption}`);
  if (item.title) lines.push(`Title: ${item.title}`);
  if (item.takenAt) lines.push(`Taken: ${formatDateTime(item.takenAt, item.trip?.timezone ?? "UTC", "EEEE, MMMM d, yyyy")}`);
  if (item.trip) lines.push(`Trip: ${item.trip.title}`);
  if (item.collections.length) lines.push(`Collections: ${item.collections.map((c) => c.collection.title).join(", ")}`);
  lines.push("This item has no location recorded. If it shows a public place you recognise, estimate it; otherwise return null.");
  return lines.join("\n");
}

/** The request shape, separate from file reading so the parameters are unit-tested. */
export function requestParams(model: string, images: ImageBlock[], text: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 4000,
    ...thinkingParams(model),
    system: [{ type: "text", text: SYSTEM_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...images, { type: "text", text }] }],
    // Keep the effort level from thinkingParams: a later key would otherwise replace the whole output_config object.
    output_config: { ...thinkingParams(model).output_config, format: zodOutputFormat(annotationSchema) },
  };
}
