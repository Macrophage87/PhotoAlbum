"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonClasses } from "@/components/ui";
import { disconnectGoogle, pickerProgress, pollPickerSession, startPickerSession } from "@/app/google/actions";

type Status = { connected: boolean; needsReconnect: boolean };
type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "picking"; sessionId: string; pickerUri: string; pollIntervalMs: number; deadline: number }
  | { kind: "downloading"; photoIds: string[]; done: number; failed: number; skipped: number; unsupported: number }
  | { kind: "error"; message: string; reconnect: boolean };

const STORAGE_KEY = "google-picker-session";

/**
 * Import from Google Photos through Google's own picker: the member chooses on photos.google.com (a new tab), this
 * tab notices when they are done and queues the downloads. The session id is kept in sessionStorage so a phone that
 * discarded the tab resumes where it left off. Google strips location from what it hands over; the notice says so.
 */
export function GooglePickerButton({ status, configured, tripId, next }: { status: Status; configured: boolean; tripId?: string | null; next: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };

  const trackDownloads = useCallback((photoIds: string[], extra: { skipped: number; unsupported: number }) => {
    const tick = async () => {
      const p = await pickerProgress(photoIds);
      setPhase({ kind: "downloading", photoIds, done: p.done, failed: p.failed, ...extra });
      if (p.done + p.failed >= p.total) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        router.push(`/review?ids=${photoIds.join(",")}&google=1`);
        return;
      }
      timer.current = setTimeout(tick, 2000);
    };
    void tick();
  }, [router]);

  const watchSession = useCallback((sessionId: string, pickerUri: string, pollIntervalMs: number, deadline: number) => {
    setPhase({ kind: "picking", sessionId, pickerUri, pollIntervalMs, deadline });
    const tick = async () => {
      // Google's session has a lifetime; past it the poll would only ever see "gone", so stop and say so.
      if (Date.now() > deadline) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        setPhase({ kind: "error", message: "That picking session has ended; start again.", reconnect: false });
        return;
      }
      const r = await pollPickerSession(sessionId, tripId ?? null);
      if (r.state === "picking") { timer.current = setTimeout(tick, pollIntervalMs); return; }
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      if (r.state === "error") { setPhase({ kind: "error", message: r.message, reconnect: r.reconnect }); return; }
      if (r.photoIds.length === 0) { setPhase({ kind: "error", message: r.skipped > 0 ? "Everything you picked is already in the album." : "Nothing importable was picked.", reconnect: false }); return; }
      trackDownloads(r.photoIds, { skipped: r.skipped, unsupported: r.unsupported });
    };
    timer.current = setTimeout(tick, pollIntervalMs);
  }, [tripId, trackDownloads]);

  // Resume a session this tab started before it was discarded.
  useEffect(() => {
    let saved: { sessionId: string; pickerUri: string; pollIntervalMs: number; deadline?: number } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null"); } catch { saved = null; }
    // Resuming is scheduled rather than done inline so the first render stays a plain render.
    const resume = saved?.sessionId && status.connected ? setTimeout(() => watchSession(saved.sessionId, saved.pickerUri, saved.pollIntervalMs || 5000, saved.deadline ?? Date.now() + 30 * 60_000), 0) : null;
    return () => { if (resume) clearTimeout(resume); stop(); };
  }, [status.connected, watchSession]);

  const start = async () => {
    setPhase({ kind: "starting" });
    const r = await startPickerSession();
    if (!r.ok) { setPhase({ kind: "error", message: r.message, reconnect: r.reconnect }); return; }
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: r.sessionId, pickerUri: r.pickerUri, pollIntervalMs: r.pollIntervalMs, deadline: r.deadline })); } catch { /* ignore */ }
    watchSession(r.sessionId, r.pickerUri, r.pollIntervalMs, r.deadline);
  };

  if (!configured) return null;
  const connectHref = `/api/google/connect?next=${encodeURIComponent(next)}`;
  return (
    <div className="rounded-theme border border-border p-4 space-y-2 text-sm" data-testid="google-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">Import from Google Photos</div>
        {status.connected && phase.kind === "idle" && <form action={disconnectGoogle}><button type="submit" className="text-muted hover:underline">Disconnect Google</button></form>}
      </div>
      {!status.connected || status.needsReconnect ? (
        <div className="space-y-2">
          <p className="text-muted">{status.needsReconnect ? "Google has forgotten this connection. Connect again to keep importing." : "Connect your Google account once, then pick photos on Google's own page each time. The album only ever sees what you pick."}</p>
          <a href={connectHref} className={buttonClasses("secondary", "sm")}>{status.needsReconnect ? "Connect again" : "Connect Google Photos"}</a>
        </div>
      ) : phase.kind === "idle" || phase.kind === "starting" ? (
        <div className="space-y-2">
          <p className="text-muted">Pick photos or clips on Google&apos;s page; they are copied into the album as if you had uploaded them. Google leaves the location out of what it hands over, so add places on the review screen.</p>
          <Button size="sm" variant="secondary" onClick={start} disabled={phase.kind === "starting"}>{phase.kind === "starting" ? "Opening…" : "Pick from Google Photos"}</Button>
        </div>
      ) : phase.kind === "picking" ? (
        <div className="space-y-2">
          <p className="text-muted">Choose in the Google Photos tab, press Done there, and come back here. This page is watching for you.</p>
          <a href={phase.pickerUri} target="_blank" rel="noopener" className={buttonClasses("primary", "sm")}>Open Google Photos</a>{" "}
          <button type="button" className="text-muted hover:underline" onClick={() => { stop(); try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } setPhase({ kind: "idle" }); }}>Cancel</button>
        </div>
      ) : phase.kind === "downloading" ? (
        <p role="status" className="text-muted">Copying {phase.photoIds.length} item{phase.photoIds.length === 1 ? "" : "s"} from Google Photos… {phase.done} ready{phase.failed > 0 ? `, ${phase.failed} failed` : ""}{phase.skipped > 0 ? ` · ${phase.skipped} already in the album` : ""}{phase.unsupported > 0 ? ` · ${phase.unsupported} unsupported` : ""}</p>
      ) : (
        <div className="space-y-2">
          <p role="alert" className="text-red-800">{phase.message}</p>
          {phase.reconnect ? <a href={connectHref} className={buttonClasses("secondary", "sm")}>Connect again</a> : <Button size="sm" variant="secondary" onClick={() => setPhase({ kind: "idle" })}>Try again</Button>}
        </div>
      )}
      {status.connected && <p className="text-xs text-muted">Connected · you can <Link href="/privacy" className="hover:underline">read what is stored</Link>.</p>}
    </div>
  );
}
