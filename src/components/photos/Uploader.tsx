"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui";

type Item = {
  localId: string;
  file: File;
  progress: number; // 0..1 upload progress
  photoId?: string;
  status: "queued" | "uploading" | "processing" | "ready" | "failed";
  error?: string;
  thumbUrl?: string | null;
  trip?: { slug: string; title: string } | null;
};

const CONCURRENCY = 3;

function uploadOne(file: File, target: { tripId?: string; activityId?: string }, optOut: boolean, onProgress: (p: number) => void): Promise<{ photoId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-last-modified", String(file.lastModified));
    if (target.tripId) xhr.setRequestHeader("x-trip-id", target.tripId);
    // An activity also settles the trip, whatever the file's own date says.
    if (target.activityId) xhr.setRequestHeader("x-activity-id", target.activityId);
    if (optOut) xhr.setRequestHeader("x-annotation-opt-out", "1");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const isVideoFile = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
/** What a phone scanner exports: a mesh the album can show, or a splat it keeps whole. */
const SCAN_EXT = /\.(glb|usdz|ply|spz)$/i;
const isScanFile = (f: File) => SCAN_EXT.test(f.name);

/**
 * Read a clip's duration in the browser so an over-long file is refused before any bytes are sent.
 * Browsers that cannot decode the file (HEVC on many desktops) report NaN: treat as unknown and let the server decide.
 */
/** Long enough that a local file always has time to give up its length, short enough never to strand an upload. */
const DURATION_TIMEOUT_MS = 10_000;

/**
 * How long a clip is, read from the file itself before anything is sent. A detached video element is not always
 * given the priority to load its metadata, and if neither event ever fires the promise used to hang and the upload
 * with it — so the element goes into the page out of sight, `load()` is asked for explicitly, both events that carry
 * a duration are listened for, and a timeout settles it either way.
 */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
    let settled = false;
    const done = (d: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      v.remove();
      resolve(d);
    };
    const fromElement = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    const timer = setTimeout(() => done(fromElement()), DURATION_TIMEOUT_MS);
    v.onloadedmetadata = () => done(fromElement());
    v.ondurationchange = () => { if (fromElement() !== null) done(fromElement()); };
    v.onerror = () => done(null);
    v.src = url;
    document.body.appendChild(v);
    v.load();
  });
}

export function tooLongMessage(durationS: number, limit: number): string {
  return `This video is ${Math.round(durationS)} seconds long; clips uploaded here are limited to ${limit} seconds. Upload longer videos to YouTube as Unlisted and add the link instead.`;
}

export function Uploader({ tripId, activityId, onDone, maxClipSeconds = 90, annotationActive = false }: { tripId?: string; /** Put what is uploaded straight into this activity, and on its trip. */ activityId?: string; onDone?: (photoIds: string[]) => void; maxClipSeconds?: number; /** Whether the AI helper is on, so the opt-out checkbox is worth showing. */ annotationActive?: boolean }) {
  const [optOut, setOptOut] = useState(false);
  const optOutRef = useRef(false);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = useRef(0);
  const queue = useRef<Item[]>([]);

  const update = useCallback((localId: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)));
  }, []);

  const pumpRef = useRef<() => void>(() => {});
  const targetRef = useRef({ tripId, activityId });
  useEffect(() => {
    targetRef.current = { tripId, activityId };
  }, [tripId, activityId]);
  useEffect(() => {
    optOutRef.current = optOut;
  }, [optOut]);
  // The queue runner lives in a ref so async completions can re-enter it without stale closures.
  useEffect(() => {
    pumpRef.current = () => {
      while (active.current < CONCURRENCY && queue.current.length) {
        const item = queue.current.shift()!;
        active.current += 1;
        update(item.localId, { status: "uploading" });
        uploadOne(item.file, targetRef.current, optOutRef.current, (p) => update(item.localId, { progress: p }))
          .then(({ photoId }) => update(item.localId, { photoId, status: "processing", progress: 1 }))
          .catch((err: Error) => update(item.localId, { status: "failed", error: err.message }))
          .finally(() => {
            active.current -= 1;
            pumpRef.current();
          });
      }
    };
  }, [update]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const accepted = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name) || isVideoFile(f) || isScanFile(f));
      const fresh: Item[] = [];
      const refused: Item[] = [];
      for (const file of accepted) {
        const item: Item = { localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`, file, progress: 0, status: "queued" };
        if (isVideoFile(file) && !isScanFile(file)) {
          const d = await readDuration(file);
          if (d !== null && d > maxClipSeconds) {
            refused.push({ ...item, status: "failed", error: tooLongMessage(d, maxClipSeconds) });
            continue;
          }
        }
        fresh.push(item);
      }
      if (!fresh.length && !refused.length) return;
      setItems((prev) => [...prev, ...refused, ...fresh]);
      queue.current.push(...fresh);
      pumpRef.current();
    },
    [maxClipSeconds],
  );

  // Poll processing status
  useEffect(() => {
    const pending = items.filter((i) => i.status === "processing" && i.photoId);
    if (!pending.length) return;
    const t = setTimeout(async () => {
      const ids = pending.map((i) => i.photoId).join(",");
      const res = await fetch(`/api/photos/status?ids=${ids}`).catch(() => null);
      if (!res || !res.ok) {
        const message = res?.status === 401 ? "Signed out. Sign in again to see the result." : "Lost contact with the server. Reload the page to check.";
        // Give up on status polling rather than spinning forever; the photos themselves are already safe.
        setItems((prev) => prev.map((it) => (it.status === "processing" ? { ...it, status: "failed", error: message } : it)));
        return;
      }
      const { photos } = (await res.json()) as { photos: { id: string; status: string; error: string | null; thumbUrl: string | null; trip: Item["trip"] }[] };
      setItems((prev) =>
        prev.map((it) => {
          const p = photos.find((x) => x.id === it.photoId);
          if (!p) return it;
          if (p.status === "READY") return { ...it, status: "ready", thumbUrl: p.thumbUrl, trip: p.trip };
          if (p.status === "FAILED") return { ...it, status: "failed", error: p.error ?? "Processing failed" };
          return it;
        }),
      );
    }, 1500);
    return () => clearTimeout(t);
  }, [items]);

  const doneIds = items.filter((i) => i.status === "ready").map((i) => i.photoId!);
  const allSettled = items.length > 0 && items.every((i) => i.status === "ready" || i.status === "failed");
  useEffect(() => {
    if (allSettled && onDone) onDone(doneIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSettled]);

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`rounded-theme border-2 border-dashed p-10 text-center transition-colors ${dragging ? "border-primary bg-primary/5" : "border-border hover:bg-surface-alt"}`}
      >
        <input ref={inputRef} id="photo-file-input" type="file" multiple accept="image/*,.heic,.heif,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.glb,.usdz,.ply,.spz" className="sr-only" tabIndex={-1} aria-label="Choose files" onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <p className="font-medium">Drop photos, short clips or 3D scans here</p>
        <p className="text-sm text-muted mt-1">
          JPEG, PNG, HEIC and more; MP4, MOV or WebM clips up to {maxClipSeconds} seconds (longer videos go on YouTube);
          3D scans from Scaniverse and the like as GLB, USDZ, PLY or SPZ. Several at a time is fine.
        </p>
        <Button type="button" variant="secondary" className="mt-4" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
      </div>

      {annotationActive && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Don&apos;t send these to the AI helper (no description will be generated; they stay on the server)
        </label>
      )}
      {items.some((i) => i.status === "failed" && i.error?.startsWith("This video is")) && (
        <ul className="text-sm text-red-700 space-y-1" role="alert">
          {items.filter((i) => i.status === "failed" && i.error?.startsWith("This video is")).map((i) => (
            <li key={i.localId}><b>{i.file.name}</b>: {i.error}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {items.map((it) => (
            <li key={it.localId} className="relative aspect-square rounded-theme overflow-hidden bg-surface-alt border border-border">
              {it.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.thumbUrl} alt={it.file.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
                  <span className="text-xs text-muted truncate w-full">{it.file.name}</span>
                  {it.status === "uploading" && (
                    <div className="w-full h-1.5 bg-border rounded mt-2 overflow-hidden">
                      <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                    </div>
                  )}
                  {it.status === "processing" && <span className="text-xs text-muted mt-2 animate-pulse">Processing…</span>}
                  {it.status === "queued" && <span className="text-xs text-muted mt-2">Waiting…</span>}
                  {it.status === "failed" && <span className="text-xs text-red-600 mt-2">{it.error}</span>}
                </div>
              )}
              {it.status === "ready" && it.trip && (
                <span className="absolute bottom-1 left-1 right-1 text-[10px] bg-black/60 text-white rounded px-1 truncate">{it.trip.title}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {allSettled && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted">
            {doneIds.length} of {items.length} uploaded.
          </span>
          {doneIds.length > 0 && (
            <Link href={`/review?ids=${doneIds.join(",")}`} className={buttonClasses("primary", "sm")}>
              Add notes and file {doneIds.length === 1 ? "it" : "them"}
            </Link>
          )}
          <Button variant="secondary" size="sm" onClick={() => setItems([])}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
