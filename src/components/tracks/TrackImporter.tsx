"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Label, Select } from "@/components/ui";
import { formatDistance } from "@/lib/time/format";

type Summary = { kind: string; format?: string; tracks: { trackId: string; activityId: string | null; name: string; pointCount: number; distanceM: number; type: string | null }[]; skipped: string[]; pointsRead: number };
type Item = { id: string; name: string; status: "uploading" | "importing" | "done" | "failed"; progress: number; jobId?: string; summary?: Summary; error?: string };

function upload(file: File, tripId: string, hint: string, onProgress: (p: number) => void): Promise<{ jobId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/tracks/import");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-trip-id", tripId);
    xhr.setRequestHeader("x-source-hint", hint);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status < 300) resolve(body);
        else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

async function waitForJob(jobId: string): Promise<Summary> {
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 3000));
    const res = await fetch(`/api/tracks/import/${jobId}`);
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const j = (await res.json()) as { state: string; summary: Summary | null; error: string | null };
    if (j.state === "completed" && j.summary) return j.summary;
    if (j.state === "failed" || j.state === "cancelled") throw new Error(j.error ?? "Import failed");
  }
  throw new Error("Timed out waiting for the import");
}

export function TrackImporter({ tripId, tripSlug }: { tripId: string; tripSlug: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [hint, setHint] = useState("auto");
  const inputRef = useRef<HTMLInputElement>(null);
  const patch = (id: string, p: Partial<Item>) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));

  const start = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((prev) => [...prev, { id, name: file.name, status: "uploading", progress: 0 }]);
      try {
        const { jobId } = await upload(file, tripId, hint, (p) => patch(id, { progress: p }));
        patch(id, { status: "importing", jobId, progress: 1 });
        const summary = await waitForJob(jobId);
        patch(id, { status: "done", summary });
      } catch (err) {
        patch(id, { status: "failed", error: (err as Error).message });
      }
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
        <div>
          <Label htmlFor="hint">File type</Label>
          <Select id="hint" value={hint} onChange={(e) => setHint(e.target.value)}>
            <option value="auto">Detect automatically</option>
            <option value="gpx">GPX track</option>
            <option value="fit">Garmin FIT activity</option>
            <option value="google">Google Timeline export (JSON)</option>
          </Select>
        </div>
        <Button onClick={() => inputRef.current?.click()}>Choose files…</Button>
        <input ref={inputRef} type="file" multiple accept=".gpx,.fit,.json,application/gpx+xml,application/json" className="hidden" onChange={(e) => e.target.files && start(e.target.files)} />
      </div>

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id} className="rounded-theme border border-border bg-surface p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium truncate">{it.name}</span>
                <span className="text-muted shrink-0">
                  {it.status === "uploading" && `Uploading ${Math.round(it.progress * 100)}%`}
                  {it.status === "importing" && <span className="animate-pulse">Importing…</span>}
                  {it.status === "done" && "Done"}
                  {it.status === "failed" && <span className="text-red-600">Failed</span>}
                </span>
              </div>
              {it.error && <p className="text-red-600 mt-2">{it.error}</p>}
              {it.summary && (
                <div className="mt-2 space-y-1">
                  <p className="text-muted">
                    {it.summary.kind.toUpperCase()}
                    {it.summary.format ? ` (${it.summary.format})` : ""} · {it.summary.pointsRead.toLocaleString()} points read
                  </p>
                  <ul className="space-y-0.5">
                    {it.summary.tracks.map((t) => (
                      <li key={t.trackId}>
                        {t.activityId ? (
                          <Link href={`/trips/${tripSlug}/activities/${t.activityId}`} className="text-primary hover:underline">{t.name}</Link>
                        ) : (
                          <span>{t.name}</span>
                        )}
                        <span className="text-muted"> · {t.pointCount.toLocaleString()} pts{t.distanceM > 0 && t.type ? ` · ${formatDistance(t.distanceM)}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                  {it.summary.skipped.map((s, i) => (
                    <p key={i} className="text-amber-700">{s}</p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
