import { env } from "@/lib/env";

/** True when a sidecar is configured; every ML feature hides itself otherwise and the rest of the app works. */
export function mlConfigured(): boolean {
  return Boolean(env().ML_URL);
}

export class MlError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export type FaceResult = { box: [number, number, number, number]; confidence: number; embedding: number[]; age: number | null };

function base(): { url: string; token: string } {
  const e = env();
  if (!e.ML_URL || !e.ML_TOKEN) throw new MlError("ML sidecar is not configured");
  return { url: e.ML_URL.replace(/\/$/, ""), token: e.ML_TOKEN };
}

async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const { url, token } = base();
  const res = await fetch(`${url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-ML-Token": token }, signal: AbortSignal.timeout(timeoutMs) }).catch((err) => {
    throw new MlError(`ML sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) throw new MlError(`ML sidecar answered ${res.status}`, res.status);
  return (await res.json()) as T;
}

function imageForm(bytes: Buffer, mediaType: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), "image");
  return form;
}

/** 512-d OpenCLIP embedding of an image. */
export async function embedImage(bytes: Buffer, mediaType = "image/webp"): Promise<number[]> {
  const r = await call<{ embedding: number[] }>("/embed/image", { method: "POST", body: imageForm(bytes, mediaType) }, 60_000);
  return r.embedding;
}

/** 384-d sentence embeddings, one per input. */
export async function embedText(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const r = await call<{ embeddings: number[][] }>("/embed/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts }) }, 30_000);
  return r.embeddings;
}

/** Faces with 512-d templates. Nothing about the image persists in the sidecar. */
export async function detectFaces(bytes: Buffer, mediaType = "image/webp"): Promise<FaceResult[]> {
  const r = await call<{ faces: FaceResult[] }>("/faces", { method: "POST", body: imageForm(bytes, mediaType) }, 60_000);
  return r.faces;
}

export async function mlHealth(): Promise<{ ok: boolean; models: string } | null> {
  if (!mlConfigured()) return null;
  try {
    const { url } = base();
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as { ok: boolean; models: string }) : { ok: false, models: "unreachable" };
  } catch {
    return { ok: false, models: "unreachable" };
  }
}

/** Format a vector for a pgvector literal. */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
}
