"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label } from "@/components/ui";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { cancelBackfill, previewBackfill, setAnnotationOptIn, startBackfill, type BackfillPreview } from "@/app/annotation/actions";
import type { BackfillScope, BackfillTask } from "@/lib/jobs/handlers/annotation-batch";

const SKIP_LABELS: Record<string, string> = { noRendition: "file could not be read", missing: "deleted meanwhile", optedOutOrDescribedMeanwhile: "opted out or described meanwhile" };
type Collapsed = (Batch & { kind: "row" }) | { kind: "more"; id: string; count: number; described: number; errored: number; canceled: number; skipped: number };

/** Long runs make many continuation rows: keep the first three, anything still open, and every marker; fold the rest into one line. */
function collapseFamilies(rows: Batch[]): Collapsed[] {
  const out: Collapsed[] = [];
  let shownInFamily = 0;
  let folded: { count: number; described: number; errored: number; canceled: number; skipped: number } | null = null;
  const flush = (familyId: string) => {
    if (folded) out.push({ kind: "more", id: `more-${familyId}`, ...folded });
    folded = null;
  };
  for (const r of rows) {
    if (!r.parentId) {
      if (out.length) flush(out[out.length - 1].id);
      shownInFamily = 0;
      out.push({ ...r, kind: "row" });
      continue;
    }
    const keep = shownInFamily < 3 || r.marker || r.status === "SUBMITTED";
    if (keep) {
      out.push({ ...r, kind: "row" });
      shownInFamily += 1;
    } else {
      folded = folded ?? { count: 0, described: 0, errored: 0, canceled: 0, skipped: 0 };
      folded.count += 1;
      folded.described += r.succeeded;
      folded.errored += r.errored;
      folded.canceled += r.canceled;
      folded.skipped += r.skipped;
    }
  }
  if (out.length) flush(out[out.length - 1].id);
  return out;
}

function describeSkips(reasons: Record<string, number>): string {
  return Object.entries(reasons).map(([k, n]) => `${n} ${SKIP_LABELS[k] ?? k}`).join(", ");
}

type Batch = { id: string; parentId: string | null; skippedReasons: Record<string, number> | null; running: boolean; /** A marker row: the rest of the run was not sent, because of an error or a worker restart. */ marker: "error" | "restart" | null; canceled: number; status: string; requested: number; succeeded: number; errored: number; skipped: number; createdAt: string; endedAt: string | null; scope: string };

export function AnnotationAdmin({ gates, model, batches, spend, rawRetentionDays }: { gates: { envEnabled: boolean; hasKey: boolean; optedInAt: string | null; active: boolean }; model: string; batches: Batch[]; /** Real spend from recorded token usage, each item at the price of the model that answered it. */ spend: { items: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; usd: number; pricesAsOf: string }; rawRetentionDays: number }) {
  const [pending, start] = useTransition();
  const [task, setTask] = useState<BackfillTask>("describe");
  const [scopeKind, setScopeKind] = useState<BackfillScope["kind"]>("all");
  const [trip, setTrip] = useState<Container | null>(null);
  const [collection, setCollection] = useState<Container | null>(null);
  const [from, setFrom] = useState("2000-01-01");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const scope = (): BackfillScope => ({
    task,
    ...(scopeKind === "trip" && trip ? { kind: "trip" as const, tripId: trip.id } : scopeKind === "collection" && collection ? { kind: "collection" as const, collectionId: collection.id } : scopeKind === "range" ? { kind: "range" as const, from, to } : { kind: "all" as const }),
  });
  const select = "h-9 rounded-theme border border-border bg-surface px-2 text-sm";

  return (
    <div className="space-y-6">
      <div className="rounded-theme border border-border bg-surface p-4 space-y-3 text-sm">
        <p className="font-medium">What would be sent to Anthropic for each item, once both switches are on</p>
        <ul className="list-disc pl-5 space-y-1 text-muted">
          <li>The 1600-pixel rendition of the photo, or three or four frames of a clip; never the original file.</li>
          <li>The uploader&apos;s notes, the caption and title, the date and camera when known, and the trip and collection titles.</li>
          <li>The names of confirmed people whose recognition an admin has turned on and who are adults, plus confirmed pet names; never face data or templates.</li>
        </ul>
        <p className="text-muted">The helper returns a caption, description, tags, place and a search summary. Raw responses are kept for {rawRetentionDays} days for debugging, then purged. Items, trips and collections can be opted out; opted-out items are never sent, including by a backfill.</p>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
          <dt className="text-muted">Operator flag</dt><dd>{gates.envEnabled ? "ANNOTATION_ENABLED is on" : "ANNOTATION_ENABLED is off (set it in .env and restart)"}</dd>
          <dt className="text-muted">API key</dt><dd>{gates.hasKey ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY is missing"}</dd>
          <dt className="text-muted">Admin opt-in</dt><dd>{gates.optedInAt ? `on since ${new Date(gates.optedInAt).toLocaleDateString("en-US")}` : "off"}</dd>
          <dt className="text-muted">Model</dt><dd>{model}</dd>
          <dt className="text-muted">Spent so far</dt><dd>{spend.items === 0 ? "nothing yet" : `about $${spend.usd.toFixed(2)} for ${spend.items} item${spend.items === 1 ? "" : "s"} (${(spend.inputTokens + spend.cacheReadTokens + spend.cacheWriteTokens).toLocaleString()} input tokens, ${spend.cacheReadTokens.toLocaleString()} of them read from cache and ${spend.cacheWriteTokens.toLocaleString()} written to it, ${spend.outputTokens.toLocaleString()} output; each item at the price of the model that answered it, as of ${spend.pricesAsOf}; re-described items count their latest answer only)`}</dd>
        </dl>
        <div className="flex items-center gap-3">
          {gates.optedInAt ? (
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(() => setAnnotationOptIn(false))}>Turn annotation off</Button>
          ) : (
            <Button size="sm" disabled={pending || !gates.envEnabled || !gates.hasKey} onClick={() => start(() => setAnnotationOptIn(true))}>Turn on annotation</Button>
          )}
          <span className={`text-xs rounded-full px-2 py-0.5 ${gates.active ? "bg-emerald-100 text-emerald-800" : "bg-surface-alt text-muted"}`}>{gates.active ? "sending new items after review" : "nothing is sent"}</span>
        </div>
      </div>

      <div className="rounded-theme border border-border bg-surface p-4 space-y-3 text-sm">
        <p className="font-medium">Work through the existing library (backfill, at half price through the Batches API)</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={task} onChange={(e) => { setTask(e.target.value as BackfillTask); setPreview(null); setTyped(""); }} className={select} aria-label="What to ask for">
            <option value="describe">Describe items that have no description</option>
            <option value="place">Place items that have no location</option>
          </select>
          <select value={scopeKind} onChange={(e) => { setScopeKind(e.target.value as BackfillScope["kind"]); setPreview(null); }} className={select} aria-label="Scope">
            <option value="all">Everywhere</option>
            <option value="trip">One trip</option>
            <option value="collection">One collection</option>
            <option value="range">A date range</option>
          </select>
          {scopeKind === "trip" && (
            <div className="w-56"><ContainerPicker kind="trip" value={trip} onChange={(v) => { setTrip(v); setPreview(null); }} placeholder="Which trip?" /></div>
          )}
          {scopeKind === "collection" && (
            <div className="w-56"><ContainerPicker kind="collection" value={collection} onChange={(v) => { setCollection(v); setPreview(null); }} placeholder="Which collection?" /></div>
          )}
          {scopeKind === "range" && (
            <>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40 h-9" aria-label="From" />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40 h-9" aria-label="To" />
            </>
          )}
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => { setMessage(null); setPreview(await previewBackfill(scope())); })}>Estimate</Button>
        </div>
        {preview && (
          <div className="rounded-theme bg-surface-alt p-3 space-y-2" role="status">
            <p>
              <b>{preview.estimate.items}</b> item{preview.estimate.items === 1 ? "" : "s"} would be sent ({preview.photos} photo{preview.photos === 1 ? "" : "s"}, {preview.videos} clip{preview.videos === 1 ? "" : "s"}), about <b>{preview.estimate.inputTokens.toLocaleString()}</b> input tokens and <b>{preview.estimate.outputTokens.toLocaleString()}</b> output tokens, roughly <b>${preview.estimate.usd.toFixed(2)}</b> on {preview.estimate.model} (approximate; prices as of {preview.estimate.pricesAsOf}).
            </p>
            <p className="text-muted">Sent per item: {preview.sends.join("; ")}. Opted-out items are skipped, and so is anything this run has already been through.</p>
            {preview.task === "place" && <p className="text-muted">The helper is asked only where each item was taken, and only answers for places anyone could name: landmarks, parks, waterfronts, plazas, a region with a look of its own. It is told to leave homes, gardens and residential streets alone. A guess never replaces a location from the camera, a track, Google or a family member, and a track imported later replaces the guess.</p>}
            <p className="text-muted">
              {preview.excluded.inScope} item{preview.excluded.inScope === 1 ? "" : "s"} in scope: {preview.excluded.described} {preview.task === "place" ? "already placed or asked about" : "already described"}, {preview.excluded.optedOutSelf} opted out, {preview.excluded.optedOutInherited} opted out through a trip or collection, {preview.estimate.items} would be sent{preview.cap ? ` (one run sends at most ${preview.cap.toLocaleString()}; run it again for the rest)` : ""}. Items whose files cannot be read are skipped at submission and counted below.
            </p>
            {preview.estimate.items > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="confirm-count" className="mb-0">Type {preview.estimate.items} to confirm</Label>
                <Input id="confirm-count" value={typed} onChange={(e) => setTyped(e.target.value)} className="w-28 h-9" />
                <Button size="sm" disabled={pending || !gates.active || typed.trim() !== String(preview.estimate.items)} onClick={() => start(async () => { try { await startBackfill(scope(), typed); setMessage("Backfill submitted. Results arrive as the batch completes, usually within an hour."); setPreview(null); setTyped(""); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not start"); } })}>Send to the helper</Button>
              </div>
            )}
          </div>
        )}
        {message && <p className="text-muted" role="status">{message}</p>}
        {batches.length > 0 && (
          <ul className="divide-y divide-border">
            {collapseFamilies(batches).map((b) => b.kind === "more" ? (
              <li key={b.id} className="py-1 pl-4 text-xs text-muted">{b.count} more continuation row{b.count === 1 ? "" : "s"} of this run: {b.described} described, {b.errored} failed{b.canceled > 0 ? `, ${b.canceled} not processed (stopped)` : ""}, {b.skipped} skipped.</li>
            ) : (
              <li key={b.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 ${b.parentId ? "pl-4 text-muted" : ""}`}>
                {b.marker ? (
                  <span>
                    {new Date(b.createdAt).toLocaleString("en-US")} · {b.marker === "restart" ? "the server restarted during this run" : "the rest of this run could not be submitted"}; run the backfill again for the remaining items{b.marker === "error" ? " (details in the worker log)" : ""}.
                  </span>
                ) : (
                  <span>
                    {new Date(b.createdAt).toLocaleString("en-US")} · {b.scope}{b.parentId ? " (continued)" : ""} · {b.requested} requested
                    {b.status !== "SUBMITTED" && <> · {b.succeeded} described, {b.errored} failed{b.canceled > 0 ? `, ${b.canceled} not processed (stopped)` : ""}, {b.skipped} skipped{b.skippedReasons ? ` (${describeSkips(b.skippedReasons)})` : ""}</>}
                    {" · "}
                    <span className="text-muted">{b.status === "SUBMITTED" ? "in progress" : b.running ? `${b.status.toLowerCase()}, still submitting the rest of the run` : b.status === "FAILED" && !b.parentId ? "failed before anything was sent; run it again (details in the worker log)" : b.status.toLowerCase()}</span>
                  </span>
                )}
                {(b.status === "SUBMITTED" || b.running) && <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => cancelBackfill(b.id))}>{b.running && b.status !== "SUBMITTED" ? "Stop the rest of this run" : "Cancel"}</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
