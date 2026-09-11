import { env } from "@/lib/env";
import { GoogleAuthError } from "./oauth";

/** The parts of a Picker session the app uses. */
export type PickerSession = { id: string; pickerUri: string; mediaItemsSet: boolean; pollIntervalMs: number; expireTime: string | null };
export type PickedItem = { id: string; type: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED"; createTime: string | null; baseUrl: string; mimeType: string; filename: string; width: number | null; height: number | null };

/** "5s" or "5.5s" → ms; the API returns protobuf durations. */
export function parseDuration(s: string | undefined, fallbackMs: number): number {
  const m = s ? /^(\d+(?:\.\d+)?)s$/.exec(s) : null;
  return m ? Math.round(Number(m[1]) * 1000) : fallbackMs;
}

async function call<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(new URL(path, `${env().GOOGLE_PHOTOS_API_URL}/`), { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) throw new GoogleAuthError(`Google Photos refused the request (${res.status})`, res.status === 401);
  if (!res.ok) throw new Error(`Google Photos request failed (${res.status})`);
  return (await res.json().catch(() => ({}))) as T;
}

type RawSession = { id: string; pickerUri: string; mediaItemsSet?: boolean; pollingConfig?: { pollInterval?: string; timeoutIn?: string }; expireTime?: string };
const toSession = (s: RawSession): PickerSession => ({ id: s.id, pickerUri: s.pickerUri, mediaItemsSet: Boolean(s.mediaItemsSet), pollIntervalMs: Math.max(2000, parseDuration(s.pollingConfig?.pollInterval, 5000)), expireTime: s.expireTime ?? null });

export async function createPickerSession(accessToken: string): Promise<PickerSession> {
  return toSession(await call<RawSession>(accessToken, "sessions", { method: "POST", body: "{}" }));
}

export async function getPickerSession(accessToken: string, id: string): Promise<PickerSession> {
  return toSession(await call<RawSession>(accessToken, `sessions/${encodeURIComponent(id)}`));
}

export async function deletePickerSession(accessToken: string, id: string): Promise<void> {
  await call(accessToken, `sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

type RawItem = { id: string; type?: PickedItem["type"]; createTime?: string; mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string; mediaFileMetadata?: { width?: number; height?: number } } };

/** Every item the member picked, across pages (the API caps a session at a few hundred items). */
export async function listPickedItems(accessToken: string, sessionId: string): Promise<PickedItem[]> {
  const out: PickedItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await call<{ mediaItems?: RawItem[]; nextPageToken?: string }>(accessToken, `mediaItems?${q}`);
    for (const it of page.mediaItems ?? []) {
      if (!it.mediaFile?.baseUrl) continue;
      out.push({ id: it.id, type: it.type ?? "TYPE_UNSPECIFIED", createTime: it.createTime ?? null, baseUrl: it.mediaFile.baseUrl, mimeType: it.mediaFile.mimeType ?? "", filename: it.mediaFile.filename ?? `${it.id}.jpg`, width: it.mediaFile.mediaFileMetadata?.width ?? null, height: it.mediaFile.mediaFileMetadata?.height ?? null });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 2000);
  return out;
}

/** The original bytes: `=d` for a photo (EXIF kept, location removed by Google), `=dv` for a video. */
export function downloadUrl(item: PickedItem): string {
  return `${item.baseUrl}${item.type === "VIDEO" ? "=dv" : "=d"}`;
}

export async function openDownload(accessToken: string, item: PickedItem): Promise<Response> {
  const res = await fetch(downloadUrl(item), { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 401 || res.status === 403) throw new GoogleAuthError(`Google Photos refused the download (${res.status})`, res.status === 401);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  return res;
}
