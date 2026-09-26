"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { backoffMs, isRetryable, MAX_ATTEMPTS, STATUS_NOTICE_AFTER, statusRetryMs } from "@/lib/media/upload-retry";
import { AttemptError, attemptUpload, statusAfterUpload, type FiledAnswer, type UploadTarget } from "@/lib/media/upload-one";

export type UploadItem = {
  localId: string;
  /** Which uploader it was added from ("upload", "activity:<id>", …), so each shows its own batch and no other. */
  scope: string;
  /** The page it was added on (path and query), for the way back from the pill. */
  from: string;
  /** Let go of once it has arrived, so a long session does not hold on to every photograph it ever sent. */
  file: File | null;
  name: string;
  progress: number; // 0..1 upload progress
  photoId?: string;
  status: "queued" | "uploading" | "processing" | "ready" | "failed";
  error?: string;
  /** How many goes this file has had in this round, so the queue knows when to stop and the tile can say it is retrying. */
  attempts?: number;
  /** Every go it has had, rounds included, so the album can tell a retry from the same file chosen again. */
  tries: number;
  /** Set while waiting out a dropped connection before the next go. */
  retrying?: boolean;
  /** The album already had this exact file, so nothing was added and the tile points at the one it has. */
  duplicate?: boolean;
  /** For a duplicate sent to a particular trip, activity or collection: whether the one the album has was put there. */
  filed?: FiledAnswer;
  /** Whose it is, when it is somebody else's and so was left where it was. */
  owner?: string | null;
  thumbUrl?: string | null;
  trip?: { slug: string; title: string } | null;
  /** Where it was sent and whether it may go to the AI helper, fixed when it was added: choosing another trip part-way
   * through a batch changes where the files added after that go, not the ones already on their way. */
  target: UploadTarget;
  optOut: boolean;
  /** A failure the member has been shown (on the page it was added from) or has dismissed from the pill. */
  seen?: boolean;
};

/** The batch an uploader shows by default: the place its files are sent to. */
export function scopeFor(target: UploadTarget): string {
  return `to:${target.activityId ?? ""}:${target.collectionId ?? ""}:${target.tripId ?? ""}`;
}

type Queue = {
  items: UploadItem[];
  /** The first file of the batch in hand: everything added since the queue last had nothing going. */
  batchFrom: string | null;
  add: (items: UploadItem[]) => void;
  /** Put a scope's files that never arrived back on the queue, from the top. */
  retry: (scope: string) => void;
  /** Take a scope's finished files off the list. */
  clear: (scope: string) => void;
  /** The member has seen these failures (or waved them away), so the pill need not keep pointing at them. */
  acknowledge: (scope?: string) => void;
  /** Set when answers about processing have stopped coming back for a while; says so without failing anything. */
  statusTrouble: null | "offline" | "signedout";
};

const QueueContext = createContext<Queue | null>(null);

/** With no provider above (it should always be there), a queue that holds nothing and does nothing, not an error page. */
const INERT: Queue = { items: [], batchFrom: null, add: () => {}, retry: () => {}, clear: () => {}, acknowledge: () => {}, statusTrouble: null };

export function useUploadQueue(): Queue {
  return useContext(QueueContext) ?? INERT;
}

const CONCURRENCY = 3;

/** How many to ask about at once, so a long batch never builds an address longer than something in front will take. */
export const MAX_STATUS_IDS = 60;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const inPlay = (i: UploadItem) => i.status === "queued" || i.status === "uploading" || i.status === "processing";

/**
 * The one queue of uploads for the whole album, mounted once in the root layout.
 *
 * It used to live in each uploader, so leaving the page — pressing Done, following a link, choosing from the album
 * instead — either stopped the batch or left it going unseen. Here it outlives any page: a member can go and look at
 * the trip while the photos they just added go up, and a small pill says how far along it is. Only closing the tab
 * stops it, and that is warned about while anything is still to be sent.
 */
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const active = useRef(0);
  const [statusTrouble, setStatusTrouble] = useState<Queue["statusTrouble"]>(null);

  const update = useCallback((localId: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)));
  }, []);

  const itemsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // The queue runner lives in a ref so async completions can re-enter it without stale closures.
  const pumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    /**
     * Send one file, waiting out anything that was the connection's fault rather than the album's. Whatever
     * happens, this returns — the slot it holds is given back in the caller's `finally`, and a slot that is never
     * given back is what used to stop a long batch in its tracks.
     */
    const send = async (item: UploadItem) => {
      let tries = item.tries;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        tries += 1;
        update(item.localId, { status: "uploading", attempts: attempt, tries, retrying: false, error: undefined });
        try {
          const answer = await attemptUpload(item.file!, item.target, item.optOut, (p) => update(item.localId, { progress: p }), () => {}, tries);
          const { photoId, duplicate, filed, owner } = answer;
          // The album already holds these bytes: nothing was added, and the tile points at the one it has rather
          // than pretending a second copy went up. Only one that is finished is ready; one still being processed (or
          // this member's own, whose first answer was lost on the way back) is watched like any other.
          update(item.localId, { photoId, status: statusAfterUpload(answer), progress: 1, retrying: false, duplicate, filed, owner, file: null });
          return;
        } catch (err) {
          const failure = err instanceof AttemptError ? err.failure : { kind: "network" as const, message: err instanceof Error ? err.message : "Upload failed" };
          const last = attempt >= MAX_ATTEMPTS;
          if (!isRetryable(failure) || last) {
            const message = isRetryable(failure) ? `${failure.message} Tried ${MAX_ATTEMPTS} times.` : failure.message;
            update(item.localId, { status: "failed", error: message, retrying: false, progress: 0 });
            return;
          }
          update(item.localId, { status: "queued", retrying: true, progress: 0, error: failure.message });
          await wait(backoffMs(attempt));
        }
      }
    };
    pumpRef.current = () => {
      while (active.current < CONCURRENCY && queue.current.length) {
        const item = queue.current.shift()!;
        active.current += 1;
        void send(item).finally(() => {
          active.current -= 1;
          pumpRef.current();
        });
      }
    };
  }, [update]);

  /** The first file of the batch in hand: everything added since the queue last had nothing going. */
  const [batchFrom, setBatchFrom] = useState<string | null>(null);
  const add = useCallback((fresh: UploadItem[]) => {
    if (!fresh.length) return;
    if (!itemsRef.current.some(inPlay)) setBatchFrom(fresh[0].localId);
    setItems((prev) => [...prev, ...fresh]);
    queue.current.push(...fresh);
    pumpRef.current();
  }, []);

  const retry = useCallback((scope: string) => {
    // Their goes so far are remembered (`tries`), so the album hears these as retries rather than new files.
    const again = itemsRef.current.filter((i) => i.scope === scope && i.status === "failed" && !i.photoId && i.file).map((i) => ({ ...i, status: "queued" as const, error: undefined, attempts: 0, retrying: false, progress: 0, seen: false }));
    if (!again.length) return;
    setItems((prev) => prev.map((it) => again.find((a) => a.localId === it.localId) ?? it));
    queue.current.push(...again);
    pumpRef.current();
  }, []);

  const clear = useCallback((scope: string) => {
    const kept = itemsRef.current.filter((i) => i.scope !== scope || inPlay(i));
    setItems(kept);
    // The batch in hand began with one of those just cleared: count from what is left.
    setBatchFrom((from) => (from && kept.some((i) => i.localId === from) ? from : (kept.find(inPlay)?.localId ?? null)));
  }, []);

  const acknowledge = useCallback((scope?: string) => {
    setItems((prev) => (prev.some((i) => i.status === "failed" && !i.seen && (!scope || i.scope === scope)) ? prev.map((i) => (i.status === "failed" && (!scope || i.scope === scope) ? { ...i, seen: true } : i)) : prev));
  }, []);

  /**
   * Ask the album how the processing is going, over and over until there is nothing left to ask about.
   *
   * Two mistakes are easy here and both have been made. Waiting on the whole list means every progress event — and
   * a file being sent reports its progress many times a second — cancels the wait and starts it again, so while
   * anything is going up the question is never asked at all. Waiting on only *which* items are outstanding fixes
   * that and introduces the opposite: an answer that changes nothing leaves that set the same, so no further wait
   * is ever scheduled and the asking stops after one go.
   *
   * So the timer is neither: it is started once, when something is outstanding, and stopped when nothing is. What
   * to ask about is read afresh on each tick from a ref, which no amount of re-rendering disturbs.
   */
  const pendingKey = items.filter((i) => i.status === "processing" && i.photoId).map((i) => i.photoId!).join(",");
  const pendingRef = useRef<string[]>([]);
  useEffect(() => {
    pendingRef.current = pendingKey ? pendingKey.split(",") : [];
  }, [pendingKey]);
  const anyPending = pendingKey.length > 0;
  useEffect(() => {
    if (!anyPending) return;
    // A missed answer is not a failed photograph. The photographs are on the server and being processed whether or
    // not this page is watching; a batch of a hundred takes minutes, and in minutes a phone will lock its screen or
    // change networks. Only the server saying FAILED about a photograph fails it.
    let stopped = false;
    let misses = 0;
    /** One question at a time: a wake-up arriving mid-question must not start a second round of asking. */
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      // A hundred ids is a long address; ask about the oldest and let the rest follow as these settle.
      const ids = pendingRef.current.slice(0, MAX_STATUS_IDS);
      if (!ids.length || asking) return;
      asking = true;
      const res = await fetch(`/api/photos/status?ids=${ids.join(",")}`).catch(() => null);
      asking = false;
      if (stopped) return;
      if (res?.status === 401) {
        // Nothing more can be learned until they sign in again, and asking every second will not change that.
        setStatusTrouble("signedout");
        return;
      }
      if (!res || !res.ok) {
        misses += 1;
        if (misses >= STATUS_NOTICE_AFTER) setStatusTrouble("offline");
        schedule(statusRetryMs(misses));
        return;
      }
      misses = 0;
      setStatusTrouble(null);
      const { photos } = (await res.json()) as { photos: { id: string; status: string; error: string | null; thumbUrl: string | null; trip: UploadItem["trip"] }[] };
      setItems((prev) =>
        prev.map((it) => {
          const p = it.status === "processing" ? photos.find((x) => x.id === it.photoId) : undefined;
          if (!p) return it;
          if (p.status === "READY") return { ...it, status: "ready", thumbUrl: p.thumbUrl, trip: p.trip };
          if (p.status === "FAILED") return { ...it, status: "failed", error: p.error ?? "Processing failed" };
          return it;
        }),
      );
      schedule(statusRetryMs(0));
    };
    schedule(statusRetryMs(0));
    // A phone coming back from a locked screen, or a laptop from sleep, is exactly when a long wait between
    // attempts is wrong: ask straight away rather than sitting out the rest of it.
    const again = () => {
      if (document.visibilityState !== "visible" || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
  }, [anyPending]);

  // Closing the tab part-way through a long batch loses whatever has not gone up yet, and a phone is quick to do it.
  const sending = items.some((i) => i.status === "queued" || i.status === "uploading");
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  return (
    <QueueContext.Provider value={{ items, batchFrom, add, retry, clear, acknowledge, statusTrouble }}>
      {children}
      <UploadPill batch={batchFrom ? items.slice(Math.max(0, items.findIndex((i) => i.localId === batchFrom))) : items} unseen={items.filter((i) => i.status === "failed" && !i.seen)} dismiss={() => acknowledge()} />
    </QueueContext.Provider>
  );
}

/**
 * How the uploads are going, wherever the member is in the album: a small line in the corner while anything is still
 * going up or being processed, which opens to say what is outstanding and leads back to where they were added. What
 * did not make it keeps it up, amber, until the member has seen the list on that page or waved it away — a failure
 * is not something to learn about only by going back to look.
 */
function UploadPill({ batch, unseen, dismiss }: { batch: UploadItem[]; unseen: UploadItem[]; dismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const going = batch.filter(inPlay);
  const toSend = going.filter((i) => i.status !== "processing").length;
  const sent = batch.filter((i) => i.photoId).length;
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  // Said to a screen reader at the moments that matter, not at every file.
  const announce = unseen.length && !going.length ? `${unseen.length} ${unseen.length === 1 ? "file" : "files"} didn't make it.` : going.length ? (toSend ? `Uploading ${batch.length} ${batch.length === 1 ? "file" : "files"}.` : `All ${batch.length} uploaded.`) : "";
  const shown = (going.length || unseen.length) && !pathname.endsWith("/add") ? <PillBody batch={batch} going={going} toSend={toSend} sent={sent} unseen={unseen} dismiss={dismiss} open={open} setOpen={setOpen} /> : null;
  // The live region stays put whatever the pill shows (or whether it shows), so every change to it is read out.
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {/* Picking from the album has its own button where this would sit; the pill is back on the next page. */}
      {shown}
    </>
  );
}

function PillBody({ batch, going, toSend, sent, unseen, dismiss, open, setOpen }: { batch: UploadItem[]; going: UploadItem[]; toSend: number; sent: number; unseen: UploadItem[]; dismiss: () => void; open: boolean; setOpen: (f: (o: boolean) => boolean) => void }) {
  const place = "fixed z-40 left-4 sm:left-auto sm:right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] max-w-[calc(100vw-2rem)] text-sm";
  if (!going.length) {
    const back = unseen[unseen.length - 1].from;
    return (
      <div className={place} data-testid="upload-pill">
        <div className="flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-900 shadow-lg pl-4 pr-1 py-1">
          <Link href={back} data-testid="upload-pill-review">
            {unseen.length} {unseen.length === 1 ? "file" : "files"} didn&apos;t make it — <span className="underline underline-offset-2">Review</span>
          </Link>
          <button type="button" onClick={dismiss} aria-label="Dismiss" className="px-2 py-1 rounded-full hover:bg-amber-200">×</button>
        </div>
      </div>
    );
  }
  const back = going[going.length - 1].from;
  return (
    <div className={place} data-testid="upload-pill">
      {open && (
        <div id="upload-pill-panel" className="mb-2 w-72 rounded-theme border border-border bg-surface p-3 shadow-lg space-y-2">
          <p>
            {toSend > 0 ? `${toSend} still to send` : "All sent"}
            {going.length - toSend > 0 ? `; ${going.length - toSend} being processed` : ""}
            {unseen.length ? `; ${unseen.length} didn't make it` : ""}.
          </p>
          <p className="text-muted">You can keep using the album while these go up; don&apos;t close the tab until they&apos;re done.</p>
          <Link href={back} className="text-primary underline underline-offset-2" onClick={() => setOpen(() => false)}>
            See them where they were added
          </Link>
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="upload-pill-panel" className="rounded-full bg-primary text-primary-fg px-4 py-2 shadow-lg">
        {toSend > 0 ? `Uploading ${sent} of ${batch.length}` : `Processing ${going.length}`}
      </button>
    </div>
  );
}
