"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui";
import { albumTakes, isScanPick, isVideoPick, refusalFor } from "@/lib/media/picker";
import { backoffMs, isRetryable, MAX_ATTEMPTS, MAX_BATCH, overCapMessage, progressLine, STATUS_NOTICE_AFTER, statusRetryMs } from "@/lib/media/upload-retry";
import { AttemptError, attemptUpload, type FiledAnswer } from "@/lib/media/upload-one";

type Item = {
  localId: string;
  file: File;
  progress: number; // 0..1 upload progress
  photoId?: string;
  status: "queued" | "uploading" | "processing" | "ready" | "failed";
  error?: string;
  /** How many goes this file has had, so the queue knows when to stop trying and the tile can say it is retrying. */
  attempts?: number;
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
};

const CONCURRENCY = 3;

/** How many to ask about at once, so a long batch never builds an address longer than something in front will take. */
const MAX_STATUS_IDS = 60;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export function Uploader({ tripId, activityId, collectionId, onDone, maxClipSeconds = 90, annotationActive = false }: { tripId?: string; /** Put what is uploaded straight into this activity, and on its trip. */ activityId?: string; /** Put what is uploaded into this collection as well. */ collectionId?: string; onDone?: (photoIds: string[]) => void; maxClipSeconds?: number; /** Whether the AI helper is on, so the opt-out checkbox is worth showing. */ annotationActive?: boolean }) {
  const [optOut, setOptOut] = useState(false);
  const optOutRef = useRef(false);
  const [items, setItems] = useState<Item[]>([]);
  /** Files turned away before a byte was sent. They never become tiles: nothing of them ever left the device. */
  const [refusals, setRefusals] = useState<{ key: string; name: string; why: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  // Two ways in, because one chooser cannot serve both. See the inputs below.
  const inputRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const active = useRef(0);
  const queue = useRef<Item[]>([]);
  /** How to stop each upload that is in the air, so leaving the page does not leave requests running. */
  const inFlight = useRef(new Map<string, () => void>());

  /** The list as it is now, for code that runs outside a render (adding files) and must not read a stale copy. */
  const itemsRef = useRef<Item[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  /** Set when answers about processing have stopped coming back for a while; says so without failing anything. */
  const [statusTrouble, setStatusTrouble] = useState<null | "offline" | "signedout">(null);

  const update = useCallback((localId: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)));
  }, []);

  const pumpRef = useRef<() => void>(() => {});
  const targetRef = useRef({ tripId, activityId, collectionId });
  useEffect(() => {
    targetRef.current = { tripId, activityId, collectionId };
  }, [tripId, activityId, collectionId]);
  useEffect(() => {
    optOutRef.current = optOut;
  }, [optOut]);
  // The queue runner lives in a ref so async completions can re-enter it without stale closures.
  useEffect(() => {
    /**
     * Send one file, waiting out anything that was the connection's fault rather than the album's. Whatever
     * happens, this returns — the slot it holds is given back in the caller's `finally`, and a slot that is never
     * given back is what used to stop a long batch in its tracks.
     */
    const send = async (item: Item) => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        update(item.localId, { status: "uploading", attempts: attempt, retrying: false, error: undefined });
        try {
          const { photoId, duplicate, filed, owner } = await attemptUpload(
            item.file,
            targetRef.current,
            optOutRef.current,
            (p) => update(item.localId, { progress: p }),
            (abort) => inFlight.current.set(item.localId, abort),
          );
          // The album already holds these bytes: nothing was added, and the tile points at the one it has rather
          // than pretending a second copy went up.
          update(item.localId, { photoId, status: duplicate ? "ready" : "processing", progress: 1, retrying: false, duplicate, filed, owner });
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
        } finally {
          inFlight.current.delete(item.localId);
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

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const fresh: Item[] = [];
      const refused: { key: string; name: string; why: string }[] = [];
      for (const file of Array.from(files)) {
        const key = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
        // Nothing narrows the chooser any more, so say plainly what was left behind rather than dropping it in silence.
        if (!albumTakes(file)) {
          refused.push({ key, name: file.name, why: refusalFor(file) });
          continue;
        }
        if (isVideoPick(file) && !isScanPick(file)) {
          const d = await readDuration(file);
          if (d !== null && d > maxClipSeconds) {
            refused.push({ key, name: file.name, why: tooLongMessage(d, maxClipSeconds) });
            continue;
          }
        }
        fresh.push({ localId: key, file, progress: 0, status: "queued" });
      }
      // What is still going counts against the cap too, so adding a hundred, then another hundred, then another
      // before the first have finished is the same as adding three hundred at once.
      const inPlay = itemsRef.current.filter((i) => i.status === "queued" || i.status === "uploading" || i.status === "processing").length;
      const room = Math.max(0, MAX_BATCH - inPlay);
      if (fresh.length > room) {
        const over = fresh.splice(room);
        refused.push({ key: `cap-${over[0].localId}`, name: over.length === 1 ? over[0].file.name : `${over.length} files`, why: overCapMessage(over.length) });
      }
      if (!fresh.length && !refused.length) return;
      if (refused.length) setRefusals((prev) => [...prev, ...refused]);
      setItems((prev) => [...prev, ...fresh]);
      queue.current.push(...fresh);
      pumpRef.current();
    },
    [maxClipSeconds],
  );

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
  const pending = items.filter((i) => i.status === "processing" && i.photoId).map((i) => i.photoId!);
  const pendingRef = useRef<string[]>([]);
  const pendingKey = pending.join(",");
  // Kept in a ref so a tick always asks about what is outstanding now, without the timer itself depending on it.
  useEffect(() => {
    pendingRef.current = pendingKey ? pendingKey.split(",") : [];
  }, [pendingKey]);
  const anyPending = pending.length > 0;
  useEffect(() => {
    if (!anyPending) return;
    // A missed answer is not a failed photograph. The photographs are on the server and being processed whether or
    // not this page is watching; a batch of a hundred takes minutes, and in minutes a phone will lock its screen or
    // change networks. This used to mark every photograph still processing as failed at the first missed answer —
    // and then list all of them as ones the album could not keep. Now a missed answer is waited out, longer each
    // time, and only the server saying FAILED about a photograph fails it.
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

  /**
   * Everything the album would not keep, in one place a member will actually read. Some of it never left the
   * device; an over-long clip whose length the browser could not read is only found out about by the server,
   * so that one arrives back as a failed upload and belongs in the same list.
   */
  const turnedAway = [
    ...refusals,
    // These did go up; the album could not make anything of them afterwards — an over-long clip, a file that is not
    // the picture its name claims. They belong here rather than among the ones that never arrived.
    ...items.filter((i) => i.status === "failed" && i.photoId).map((i) => ({ key: i.localId, name: i.file.name, why: i.error ?? "The album could not make sense of it." })),
  ];
  const doneIds = items.filter((i) => i.status === "ready").map((i) => i.photoId!);
  const allSettled = items.length > 0 && items.every((i) => i.status === "ready" || i.status === "failed");
  /** The ones that never reached the album at all. Everything else arrived, whatever became of it afterwards. */
  const failed = items.filter((i) => i.status === "failed" && !i.photoId);
  // A file the album already had is one of three things: put where it was sent instead of copied, left where it is
  // because it is somebody else's, or simply already there with nowhere in particular asked for.
  const filedHere = items.filter((i) => i.duplicate && i.filed && (i.filed.trip || i.filed.activity || i.filed.collection));
  const notYours = items.filter((i) => i.duplicate && i.filed?.notYours);
  const alreadyHere = items.filter((i) => i.duplicate && !filedHere.includes(i) && !notYours.includes(i));
  const counts = {
    done: items.filter((i) => Boolean(i.photoId)).length,
    failed: failed.length,
    waiting: items.filter((i) => i.retrying).length,
    inFlight: items.filter((i) => i.status === "uploading").length,
    total: items.length,
    ready: items.filter((i) => i.status === "ready").length,
    processing: items.filter((i) => i.status === "processing").length,
  };
  /** Anything a member would want to know before closing the tab, said in one line rather than in a hundred tiles. */
  const busy = items.some((i) => i.status === "queued" || i.status === "uploading");

  // Closing the tab part-way through a long batch loses whatever has not gone up yet, and a phone is quick to do it.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  /** Put the ones that did not make it back on the queue, from the top, with their attempts forgotten. */
  const retryFailed = () => {
    const again = failed.map((i) => ({ ...i, status: "queued" as const, error: undefined, attempts: 0, retrying: false, progress: 0 }));
    if (!again.length) return;
    setItems((prev) => prev.map((it) => again.find((a) => a.localId === it.localId) ?? it));
    queue.current.push(...again);
    pumpRef.current();
  };
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
        {/*
          Deliberately no `accept` here. A phone reads `accept="image/*"` as "the member wants the photo app", and
          Android then opens Google Photos with no way through to the phone's own storage — which is where a file
          copied off a camera, a scanner's .glb, or anything downloaded actually lives. Left unnarrowed, the chooser
          offers everything the phone has, storage included. What the album will not take is turned away afterwards,
          by name, in the list below.
        */}
        <input ref={inputRef} id="photo-file-input" type="file" multiple className="sr-only" tabIndex={-1} aria-label="Files on this device" onChange={(e) => e.target.files && addFiles(e.target.files)} />
        {/* And the short way round for the usual case, straight to the phone's camera roll. */}
        <input ref={libraryRef} id="photo-library-input" type="file" multiple accept="image/*,video/*" className="sr-only" tabIndex={-1} aria-label="Photo library on this device" onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <p className="font-medium">Drop photos, short clips or 3D scans here</p>
        <p className="text-sm text-muted mt-1">
          JPEG, PNG, HEIC and more; MP4, MOV or WebM clips up to {maxClipSeconds} seconds (longer videos go on YouTube);
          3D scans from Scaniverse and the like as GLB, USDZ, PLY or SPZ. Up to {MAX_BATCH} at a time; a big batch takes a
          few minutes to finish after it arrives, and carries on even if you leave this page.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="secondary" onClick={() => libraryRef.current?.click()}>
            Photos and videos
          </Button>
          <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>
            Browse files
          </Button>
        </div>
        <p className="text-xs text-muted mt-2">On a phone, &ldquo;Browse files&rdquo; reaches your downloads and storage as well as the photo app.</p>
      </div>

      {annotationActive && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Don&apos;t send these to the AI helper (no description will be generated; they stay on the server)
        </label>
      )}
      {turnedAway.length > 0 && (
        <ul className="text-sm text-red-700 space-y-1" role="alert">
          {turnedAway.map((r) => (
            <li key={r.key}><b>{r.name}</b>: {r.why}</li>
          ))}
        </ul>
      )}
      {/*
        How the batch is going, in one line. A hundred photographs is a hundred small squares, and a red word inside
        one of them is not something anybody sees — which is how a batch that had stopped could look like a batch
        that was still going.
      */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="upload-progress">
          <span aria-live="polite" className={counts.failed ? "font-medium text-red-700" : "text-muted"}>{progressLine(counts)}</span>
          {counts.waiting > 0 && <span className="text-amber-700">The connection dropped; trying again.</span>}
        </div>
      )}
      {/* Said without failing anything: the photographs are on the server either way, and are being processed. */}
      {statusTrouble && counts.processing > 0 && (
        <p className="text-sm text-amber-800" role="status" data-testid="status-trouble">
          {statusTrouble === "signedout"
            ? "You were signed out, so this page cannot see how the rest turned out. They are safe on the server — sign in again and they will be in the album."
            : "This page has lost touch with the album for a moment. The photographs are safe on the server and still being processed; it will keep asking."}
        </p>
      )}

      {allSettled && filedHere.length > 0 && (
        <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-1 text-sm" data-testid="filed-here">
          <p className="font-medium">
            {filedHere.length} {filedHere.length === 1 ? "was" : "were"} already in the album, so {filedHere.length === 1 ? "it was" : "they were"} put where you chose instead of being copied.
          </p>
          <ul className="text-muted space-y-0.5 max-h-40 overflow-y-auto">
            {filedHere.map((i) => (
              <li key={i.localId}>
                <b>{i.file.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">{i.filed?.movedFrom ? `moved here from ${i.filed.movedFrom}` : "now here"}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {allSettled && notYours.length > 0 && (
        <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-1 text-sm" data-testid="not-yours">
          <p className="font-medium">
            {notYours.length} {notYours.length === 1 ? "is" : "are"} already in the album, added by someone else. Only they or an admin can move {notYours.length === 1 ? "it" : "them"}, so {notYours.length === 1 ? "it was" : "they were"} left where {notYours.length === 1 ? "it is" : "they are"}.
          </p>
          <ul className="text-muted space-y-0.5 max-h-40 overflow-y-auto">
            {notYours.map((i) => (
              <li key={i.localId}>
                <b>{i.file.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">{i.owner ? `${i.owner}'s copy` : "the copy the album has"}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {allSettled && alreadyHere.length > 0 && (
        <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-1 text-sm" data-testid="already-here">
          <p className="font-medium">
            {alreadyHere.length} {alreadyHere.length === 1 ? "was" : "were"} already in the album — the same file, so nothing was added.
          </p>
          <ul className="text-muted space-y-0.5 max-h-40 overflow-y-auto">
            {alreadyHere.map((i) => (
              <li key={i.localId}>
                <b>{i.file.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">the copy the album has</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {allSettled && failed.length > 0 && (
        <div className="rounded-theme border border-red-300 bg-red-50 p-3 space-y-2 text-sm" role="alert" data-testid="upload-failures">
          <p className="font-medium text-red-800">
            {failed.length} {failed.length === 1 ? "file" : "files"} did not go up.
          </p>
          <ul className="text-red-700 space-y-0.5 max-h-40 overflow-y-auto">
            {failed.map((i) => (
              <li key={i.localId}><b>{i.file.name}</b>: {i.error}</li>
            ))}
          </ul>
          <Button type="button" variant="secondary" size="sm" onClick={retryFailed} data-testid="retry-failed">
            Try {failed.length === 1 ? "it" : "those"} again
          </Button>
        </div>
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
                  {it.status === "queued" && <span className="text-xs text-muted mt-2">{it.retrying ? "Trying again…" : "Waiting…"}</span>}
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
            // A long batch is a long address: past what the status check asks about in one go, send them to the
            // review page as a whole, where everything not yet reviewed — these included — is waiting.
            <Link href={doneIds.length <= MAX_STATUS_IDS ? `/review?ids=${doneIds.join(",")}` : "/review"} className={buttonClasses("primary", "sm")}>
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
