"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Label, Select } from "@/components/ui";
import { formatDistance } from "@/lib/time/format";
import { sendTrackFile, waitForImport, type ImportSummary } from "@/lib/tracks/import-client";

type Item = { id: string; name: string; status: "uploading" | "importing" | "done" | "failed"; progress: number; jobId?: string; summary?: ImportSummary; error?: string; trouble?: boolean };

export function TrackImporter({ tripId, tripSlug }: { tripId: string; tripSlug: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [hint, setHint] = useState("auto");
  const [replaceGoogle, setReplaceGoogle] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const patch = (id: string, p: Partial<Item>) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));

  // Closing the tab while a file is still going up loses it (a Google export can take minutes); once it is up, the
  // import carries on without this page.
  const sending = items.some((i) => i.status === "uploading");
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  const start = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((prev) => [...prev, { id, name: file.name, status: "uploading", progress: 0 }]);
      try {
        const { jobId } = await sendTrackFile(file, tripId, hint, replaceGoogle, (p) => patch(id, { progress: p }));
        patch(id, { status: "importing", jobId, progress: 1 });
        const summary = await waitForImport(jobId, { onTrouble: (trouble) => patch(id, { trouble }) });
        patch(id, { status: "done", summary, trouble: false });
      } catch (err) {
        patch(id, { status: "failed", error: (err as Error).message, trouble: false });
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
      {hint !== "gpx" && hint !== "fit" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={replaceGoogle} onChange={(e) => setReplaceGoogle(e.target.checked)} />
          <span>
            Replace my earlier Google traces for these days
            <span className="block text-muted">Leave this off when importing someone else&apos;s export under your account, so their traces are kept alongside yours.</span>
          </span>
        </label>
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id} className="rounded-theme border border-border bg-surface p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium truncate">{it.name}</span>
                <span className="text-muted shrink-0">
                  {it.status === "uploading" && `Uploading ${Math.round(it.progress * 100)}%`}
                  {it.status === "importing" && <span className="animate-pulse">{it.trouble ? "Importing… (reconnecting)" : "Importing…"}</span>}
                  {it.status === "done" && "Done"}
                  {it.status === "failed" && <span className="text-red-600">Failed</span>}
                </span>
              </div>
              {it.error && <p className="text-red-600 mt-2">{it.error}</p>}
              {it.summary && (
                <div className="mt-2 space-y-1">
                  <p className="text-muted">
                    {it.summary.kind.toUpperCase()}
                    {it.summary.format ? ` (${it.summary.format})` : ""} · {it.summary.pointsRead.toLocaleString("en-US")} points read
                  </p>
                  <ul className="space-y-0.5">
                    {it.summary.tracks.map((t) => (
                      <li key={t.trackId}>
                        {t.activityId ? (
                          <Link href={`/trips/${tripSlug}/activities/${t.activityId}`} className="text-primary hover:underline">{t.name}</Link>
                        ) : (
                          <span>{t.name}</span>
                        )}
                        <span className="text-muted"> · {t.pointCount.toLocaleString("en-US")} pts{t.distanceM > 0 && t.type ? ` · ${formatDistance(t.distanceM)}` : ""}</span>
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
