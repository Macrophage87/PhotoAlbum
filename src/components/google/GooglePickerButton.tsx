"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonClasses } from "@/components/ui";
import { disconnectGoogle, pickerProgress, pollPickerSession, startPickerSession } from "@/app/google/actions";
import { statusRetryMs } from "@/lib/media/upload-retry";
import { clearSavedPicker, opensInSameTab, readSavedPicker, savePicker, type PickerOpenMode } from "@/lib/google/picker-resume";

type Status = { connected: boolean; needsReconnect: boolean };
type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "picking"; sessionId: string; pickerUri: string; pollIntervalMs: number; deadline: number; mode: PickerOpenMode }
  | { kind: "downloading"; photoIds: string[]; done: number; failed: number; skipped: number; unsupported: number }
  | { kind: "error"; message: string; reconnect: boolean };

/** Missed answers in a row before the page says it is reconnecting; one on its own is ordinary on a phone. */
const TROUBLE_AFTER = 2;

/**
 * Import from Google Photos through Google's own picker. One press opens Google's page: in a new tab on a computer
 * (opened in the click itself, so the browser does not block it; a plain link is left in case it does), in this same
 * tab on a phone. This page notices when the member is done and queues the downloads. Where it is in that — picking,
 * then copying — is kept in sessionStorage, so coming back from Google in the same tab, or to a tab the phone threw
 * away, resumes and still ends on the review screen. Google strips location from what it hands over; the notice says so.
 */
export function GooglePickerButton({ status, configured, tripId, next }: { status: Status; configured: boolean; tripId?: string | null; next: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** The album has not answered for a moment; the page is still watching and says so quietly. */
  const [reconnecting, setReconnecting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };

  // A question that goes unanswered (a phone that locked its screen, a network handover, a deploy) is asked again, a
  // little later each time, as the uploader's status check does. Stopping at the first would leave the page saying
  // "watching" while it no longer was.
  const trackDownloads = useCallback((photoIds: string[], extra: { skipped: number; unsupported: number }) => {
    // Remembered until the review screen has them, so a tab lost while copying still gets there.
    savePicker({ stage: "downloading", photoIds, ...extra });
    setPhase({ kind: "downloading", photoIds, done: 0, failed: 0, ...extra });
    setReconnecting(false);
    let misses = 0;
    const tick = async () => {
      const p = await pickerProgress(photoIds).catch(() => null);
      if (!p) {
        misses += 1;
        if (misses >= TROUBLE_AFTER) setReconnecting(true);
        timer.current = setTimeout(tick, statusRetryMs(misses));
        return;
      }
      misses = 0;
      setReconnecting(false);
      setPhase({ kind: "downloading", photoIds, done: p.done, failed: p.failed, ...extra });
      if (p.done + p.failed >= p.total) {
        router.push(`/review?ids=${photoIds.join(",")}&google=1`);
        clearSavedPicker();
        return;
      }
      timer.current = setTimeout(tick, 2000);
    };
    void tick();
  }, [router]);

  const watchSession = useCallback((sessionId: string, pickerUri: string, pollIntervalMs: number, deadline: number, mode: PickerOpenMode, firstAfterMs?: number) => {
    setPhase({ kind: "picking", sessionId, pickerUri, pollIntervalMs, deadline, mode });
    setReconnecting(false);
    let misses = 0;
    const tick = async () => {
      // Google's session has a lifetime; past it the poll would only ever see "gone", so stop and say so.
      if (Date.now() > deadline) {
        clearSavedPicker();
        setPhase({ kind: "error", message: "That picking session has ended; start again.", reconnect: false });
        return;
      }
      const r = await pollPickerSession(sessionId, tripId ?? null).catch(() => null);
      if (!r) {
        misses += 1;
        if (misses >= TROUBLE_AFTER) setReconnecting(true);
        timer.current = setTimeout(tick, Math.max(pollIntervalMs, statusRetryMs(misses)));
        return;
      }
      misses = 0;
      setReconnecting(false);
      if (r.state === "picking") { timer.current = setTimeout(tick, pollIntervalMs); return; }
      if (r.state === "error") { clearSavedPicker(); setPhase({ kind: "error", message: r.message, reconnect: r.reconnect }); return; }
      if (r.photoIds.length === 0) { clearSavedPicker(); setPhase({ kind: "error", message: r.skipped > 0 ? "Everything you picked is already in the album." : "Nothing importable was picked.", reconnect: false }); return; }
      trackDownloads(r.photoIds, { skipped: r.skipped, unsupported: r.unsupported });
    };
    timer.current = setTimeout(tick, firstAfterMs ?? pollIntervalMs);
  }, [tripId, trackDownloads]);

  // Pick up where this tab was before it went to Google's page or was discarded: still picking, or still copying.
  useEffect(() => {
    const saved = readSavedPicker();
    // Resuming is scheduled rather than done inline so the first render stays a plain render.
    const resume = saved && status.connected
      ? setTimeout(() => (saved.stage === "downloading" ? trackDownloads(saved.photoIds, { skipped: saved.skipped, unsupported: saved.unsupported }) : watchSession(saved.sessionId, saved.pickerUri, saved.pollIntervalMs, saved.deadline, saved.mode, 0)), 0)
      : null;
    return () => { if (resume) clearTimeout(resume); stop(); };
  }, [status.connected, watchSession, trackDownloads]);

  const start = async () => {
    const sameTab = opensInSameTab();
    // Opened now, inside the click, while the browser still counts it as the member's own doing; it is pointed at
    // Google's page once the session exists. Null when a popup blocker said no: the link below is then the way in.
    let tab: Window | null = null;
    if (!sameTab) {
      try { tab = window.open("", "_blank"); } catch { tab = null; }
      if (tab) {
        try { tab.opener = null; tab.document.title = "Opening Google Photos…"; tab.document.body.textContent = "Opening Google Photos…"; } catch { /* ignore */ }
      }
    }
    setPhase({ kind: "starting" });
    const r = await startPickerSession().catch(() => ({ ok: false as const, reconnect: false, message: "The album is not answering. Try again in a moment." }));
    if (!r.ok) {
      tab?.close();
      setPhase({ kind: "error", message: r.message, reconnect: r.reconnect });
      return;
    }
    const mode: PickerOpenMode = sameTab ? "same" : tab && !tab.closed ? "tab" : "blocked";
    savePicker({ stage: "picking", sessionId: r.sessionId, pickerUri: r.pickerUri, pollIntervalMs: r.pollIntervalMs, deadline: r.deadline, mode });
    if (sameTab) {
      // Off to Google in this tab. Coming back either restores this page as it was, still watching, or loads it
      // afresh and resumes from what was just saved.
      watchSession(r.sessionId, r.pickerUri, r.pollIntervalMs, r.deadline, mode);
      window.location.assign(r.pickerUri);
      return;
    }
    if (tab && mode === "tab") {
      try { tab.location.href = r.pickerUri; } catch { /* the link below still works */ }
    }
    watchSession(r.sessionId, r.pickerUri, r.pollIntervalMs, r.deadline, mode);
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
          <p className="text-muted">
            {phase.mode === "tab" ? "Google Photos is open in another tab. Choose your photos there, press Done, then come back to this page." : phase.mode === "same" ? "Choose your photos in Google Photos and press Done. When you come back here, this page carries on by itself." : "Press Open Google Photos to choose your photos. Press Done there, then come back to this page."}
            {reconnecting ? " Reconnecting…" : ""}
          </p>
          {phase.mode === "same"
            ? <a href={phase.pickerUri} className={buttonClasses("primary", "sm")}>Open Google Photos</a>
            : <a href={phase.pickerUri} target="_blank" rel="noopener" className={buttonClasses(phase.mode === "tab" ? "secondary" : "primary", "sm")}>{phase.mode === "tab" ? "Open Google Photos again" : "Open Google Photos"}</a>}{" "}
          <button type="button" className="text-muted hover:underline" onClick={() => { stop(); clearSavedPicker(); setPhase({ kind: "idle" }); }}>Cancel</button>
        </div>
      ) : phase.kind === "downloading" ? (
        <p role="status" className="text-muted">Copying {phase.photoIds.length} item{phase.photoIds.length === 1 ? "" : "s"} from Google Photos… {phase.done} ready{phase.failed > 0 ? `, ${phase.failed} failed` : ""}{phase.skipped > 0 ? ` · ${phase.skipped} already in the album` : ""}{phase.unsupported > 0 ? ` · ${phase.unsupported} unsupported` : ""}{reconnecting ? " · reconnecting…" : ""}</p>
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
