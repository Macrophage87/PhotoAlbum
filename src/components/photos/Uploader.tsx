"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui";
import { albumTakes, isScanPick, isVideoPick, mimeAsSent, refusalFor } from "@/lib/media/picker";
import { maxUploadBytes, tooBigMessage, type UploadByteLimits } from "@/lib/media/limits";
import { MAX_BATCH, overCapMessage, progressLine } from "@/lib/media/upload-retry";
import { inPlay, MAX_STATUS_IDS, scopeFor, useUploadQueue, type UploadItem } from "./UploadQueue";

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

/** The batch line, plus any failures from an earlier batch here that were never tried again, so they are not lost. */
function withEarlier(line: string, earlier: number): string {
  if (!earlier) return line;
  const end = /[.…]$/.test(line) ? line.slice(-1) : "";
  return `${end ? line.slice(0, -1) : line} (${earlier} earlier ${earlier === 1 ? "file still needs" : "files still need"} attention)${end}`;
}

export function tooLongMessage(durationS: number, limit: number): string {
  return `This video is ${Math.round(durationS)} seconds long; clips uploaded here are limited to ${limit} seconds. Upload longer videos to YouTube as Unlisted and add the link instead.`;
}

export function Uploader({ tripId, activityId, collectionId, scope, onDone, maxClipSeconds = 90, maxBytes, annotationActive = false }: { tripId?: string; /** Put what is uploaded straight into this activity, and on its trip. */ activityId?: string; /** Put what is uploaded into this collection as well. */ collectionId?: string; /** Which batch this uploader shows; by default the place it sends to. */ scope?: string; onDone?: (photoIds: string[]) => void; maxClipSeconds?: number; /** The server's size limits, so an oversized file is refused before any of it is sent. */ maxBytes: UploadByteLimits; /** Whether the AI helper is on, so the opt-out checkbox is worth showing. */ annotationActive?: boolean }) {
  // The files themselves go up through the album-wide queue (UploadQueue), which carries on while the member moves
  // about the album; this is a view onto the ones added here.
  const queue = useUploadQueue();
  const here = scope ?? scopeFor({ tripId, activityId, collectionId });
  const items = queue.items.filter((i) => i.scope === here);
  const statusTrouble = queue.statusTrouble;
  const [optOut, setOptOut] = useState(false);
  /** Files turned away before a byte was sent. They never become tiles: nothing of them ever left the device. */
  const [refusals, setRefusals] = useState<{ key: string; name: string; why: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  // Two ways in, because one chooser cannot serve both. See the inputs below.
  const inputRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  /** The list as it is now, for code that runs outside a render (adding files) and must not read a stale copy. */
  const itemsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    itemsRef.current = queue.items;
  }, [queue.items]);
  const targetRef = useRef({ tripId, activityId, collectionId });
  useEffect(() => {
    targetRef.current = { tripId, activityId, collectionId };
  }, [tripId, activityId, collectionId]);
  const optOutRef = useRef(false);
  useEffect(() => {
    optOutRef.current = optOut;
  }, [optOut]);

  const addFiles = async (files: FileList | File[]) => {
    const fresh: UploadItem[] = [];
    const refused: { key: string; name: string; why: string }[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
      // Nothing narrows the chooser any more, so say plainly what was left behind rather than dropping it in silence.
      if (!albumTakes(file)) {
        refused.push({ key, name: file.name, why: refusalFor(file) });
        continue;
      }
      // Held to the limit the server will use, so it is refused here rather than after it has all been sent.
      const limit = maxUploadBytes(mimeAsSent({ name: file.name, type: file.type || "application/octet-stream" }) ?? "", maxBytes);
      if (file.size > limit) {
        refused.push({ key, name: file.name, why: tooBigMessage(file.size, limit) });
        continue;
      }
      if (isVideoPick(file) && !isScanPick(file)) {
        const d = await readDuration(file);
        if (d !== null && d > maxClipSeconds) {
          refused.push({ key, name: file.name, why: tooLongMessage(d, maxClipSeconds) });
          continue;
        }
      }
      fresh.push({ localId: key, scope: here, from: `${window.location.pathname}${window.location.search}`, file, name: file.name, progress: 0, status: "queued", tries: 0, target: { ...targetRef.current }, optOut: optOutRef.current });
    }
    // What is still going counts against the cap too, so adding a hundred, then another hundred, then another
    // before the first have finished is the same as adding three hundred at once.
    const room = Math.max(0, MAX_BATCH - itemsRef.current.filter(inPlay).length);
    if (fresh.length > room) {
      const over = fresh.splice(room);
      refused.push({ key: `cap-${over[0].localId}`, name: over.length === 1 ? over[0].name : `${over.length} files`, why: overCapMessage(over.length) });
    }
    if (!fresh.length && !refused.length) return;
    if (refused.length) setRefusals((prev) => [...prev, ...refused]);
    queue.add(fresh);
  };

  /**
   * Everything the album would not keep, in one place a member will actually read. Some of it never left the
   * device; an over-long clip whose length the browser could not read is only found out about by the server,
   * so that one arrives back as a failed upload and belongs in the same list.
   */
  const turnedAway = [
    ...refusals,
    // These did go up; the album could not make anything of them afterwards — an over-long clip, a file that is not
    // the picture its name claims. They belong here rather than among the ones that never arrived.
    ...items.filter((i) => i.status === "failed" && i.photoId).map((i) => ({ key: i.localId, name: i.name, why: i.error ?? "The album could not make sense of it." })),
  ];
  const doneIds = items.filter((i) => i.status === "ready").map((i) => i.photoId!);
  const allSettled = items.length > 0 && items.every((i) => i.status === "ready" || i.status === "failed");
  /** The ones that never reached the album at all. Everything else arrived, whatever became of it afterwards. */
  const failed = items.filter((i) => i.status === "failed" && !i.photoId);
  // A file the album already had is one of three things: put where it was sent instead of copied, left where it is
  // because it is somebody else's, or simply already there with nowhere in particular asked for.
  // One whose processing failed is in the list of what the album would not keep, and nowhere else.
  const duplicates = items.filter((i) => i.duplicate && i.status !== "failed");
  const filedHere = duplicates.filter((i) => i.filed && (i.filed.trip || i.filed.activity || i.filed.collection));
  const notYours = duplicates.filter((i) => i.filed?.notYours);
  const alreadyHere = duplicates.filter((i) => !filedHere.includes(i) && !notYours.includes(i));
  // The line counts the batch in hand, as the pill does: what was added since the queue was last idle (or, when this
  // place added nothing since then, its own last batch).
  const from = queue.batchFrom ? queue.items.findIndex((i) => i.localId === queue.batchFrom) : -1;
  const current = from >= 0 ? queue.items.slice(from).filter((i) => i.scope === here) : [];
  const batch = current.length ? current : items;
  const counts = {
    done: batch.filter((i) => Boolean(i.photoId) && i.status !== "failed").length,
    failed: batch.filter((i) => i.status === "failed").length,
    waiting: batch.filter((i) => i.retrying).length,
    inFlight: batch.filter((i) => i.status === "uploading").length,
    total: batch.length,
    ready: batch.filter((i) => i.status === "ready").length,
    processing: batch.filter((i) => i.status === "processing").length,
  };
  /** Put the ones that did not make it back on the queue, from the top. */
  const retryFailed = () => queue.retry(here);
  // Only when a batch settles while this is on screen: coming back to one that settled already is not news.
  const wasSettled = useRef(allSettled);
  useEffect(() => {
    if (allSettled && !wasSettled.current && onDone) onDone(doneIds);
    wasSettled.current = allSettled;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSettled]);
  // Once the list of what did not make it is on this page, the pill elsewhere need not keep saying so.
  const unseenFailures = items.some((i) => i.status === "failed" && !i.seen);
  const { acknowledge } = queue;
  useEffect(() => {
    if (allSettled && unseenFailures) acknowledge(here);
  }, [allSettled, unseenFailures, acknowledge, here]);

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
          3D scans from Scaniverse and the like as GLB, USDZ, PLY or SPZ. Up to {MAX_BATCH} at a time. You can keep using the
          album while these go up; don&apos;t close the tab until they&apos;re done.
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
          <span aria-live="polite" className={counts.failed ? "font-medium text-red-700" : "text-muted"}>{withEarlier(progressLine(counts), items.filter((i) => i.status === "failed" && !batch.includes(i)).length)}</span>
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
                <b>{i.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">{i.filed?.movedFrom ? `moved here from ${i.filed.movedFrom}` : "now here"}</Link>
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
                <b>{i.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">{i.owner ? `${i.owner}'s copy` : "the copy the album has"}</Link>
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
                <b>{i.name}</b>: <Link href={`/photos/${i.photoId}`} className="text-primary underline underline-offset-2">the copy the album has</Link>
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
              <li key={i.localId}><b>{i.name}</b>: {i.error}</li>
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
                <img src={it.thumbUrl} alt={it.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
                  <span className="text-xs text-muted truncate w-full">{it.name}</span>
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
          <Button variant="secondary" size="sm" onClick={() => { queue.clear(here); setRefusals([]); }}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
