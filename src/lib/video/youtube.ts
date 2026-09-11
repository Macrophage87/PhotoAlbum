import { env } from "@/lib/env";

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

/**
 * Extract the 11-character video id from any common YouTube URL form, or null for anything else
 * (other hosts, malformed ids, junk). Pure and safe to call on untrusted input.
 */
export function parseYouTubeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID.test(raw) && !raw.includes(".")) return raw; // a bare id pasted from the share box
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let candidate: string | null = null;
  if (host === "youtu.be") candidate = parts[0] ?? null;
  else if (parts[0] === "watch") candidate = url.searchParams.get("v");
  else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) candidate = parts[1] ?? null;
  else candidate = url.searchParams.get("v");
  return candidate && ID.test(candidate) ? candidate : null;
}

export function canonicalUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Privacy-enhanced embed: no cookies until the viewer presses play in the iframe. */
export function embedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1`;
}

export type OEmbed = { title: string; authorName: string | null; thumbnailUrl: string | null };

export class YouTubeError extends Error {
  constructor(public code: "unavailable" | "network" | "invalid", message: string, public status?: number) {
    super(message);
  }
}

/** Title, author and thumbnail from YouTube's oEmbed endpoint (no API key). 401/403/404 mean private or gone. */
export async function oembed(id: string, timeoutMs = 8000): Promise<OEmbed> {
  const url = new URL(env().YOUTUBE_OEMBED_URL);
  url.searchParams.set("url", canonicalUrl(id));
  url.searchParams.set("format", "json");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  } catch (err) {
    throw new YouTubeError("network", `YouTube did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ([401, 403, 404].includes(res.status)) throw new YouTubeError("unavailable", "That video is private, deleted, or cannot be embedded.", res.status);
  if (!res.ok) throw new YouTubeError("network", `YouTube answered ${res.status}`, res.status);
  const body = (await res.json().catch(() => null)) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown } | null;
  if (!body || typeof body.title !== "string") throw new YouTubeError("invalid", "YouTube returned an unexpected answer.");
  return { title: body.title, authorName: typeof body.author_name === "string" ? body.author_name : null, thumbnailUrl: typeof body.thumbnail_url === "string" ? body.thumbnail_url : null };
}

/** The best poster YouTube has: maxresdefault when it exists, else hqdefault. */
export async function fetchThumbnail(id: string, timeoutMs = 10000): Promise<Buffer> {
  const base = env().YOUTUBE_THUMBNAIL_URL.replace(/\/$/, "");
  for (const name of ["maxresdefault.jpg", "hqdefault.jpg"]) {
    const res = await fetch(`${base}/${id}/${name}`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
  }
  throw new YouTubeError("unavailable", "No thumbnail could be fetched for that video.");
}

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

/** Duration via the Data API when a key is configured; null otherwise or on any failure. */
export async function fetchDuration(id: string): Promise<number | null> {
  const key = env().YOUTUBE_API_KEY;
  if (!key) return null;
  const url = new URL(`${env().YOUTUBE_DATA_API_URL.replace(/\/$/, "")}/videos`);
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", id);
  url.searchParams.set("key", key);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { items?: { contentDetails?: { duration?: string } }[] } | null;
  const iso = body?.items?.[0]?.contentDetails?.duration;
  return iso ? parseIsoDuration(iso) : null;
}
