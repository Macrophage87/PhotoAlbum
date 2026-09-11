"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label } from "@/components/ui";
import { cancelBackfill, previewBackfill, setAnnotationOptIn, startBackfill, type BackfillPreview } from "@/app/annotation/actions";
import type { BackfillScope } from "@/lib/jobs/handlers/annotation-batch";

const SKIP_LABELS: Record<string, string> = { noRendition: "file could not be read", missing: "deleted meanwhile", optedOutOrDescribedMeanwhile: "opted out or described meanwhile" };
function describeSkips(reasons: Record<string, number>): string {
  return Object.entries(reasons).map(([k, n]) => `${n} ${SKIP_LABELS[k] ?? k}`).join(", ");
}

type Batch = { id: string; parentId: string | null; skippedReasons: Record<string, number> | null; status: string; requested: number; succeeded: number; errored: number; skipped: number; createdAt: string; endedAt: string | null; scope: string };
type Option = { id: string; title: string };

export function AnnotationAdmin({ gates, model, trips, collections, batches, spend, rawRetentionDays }: { gates: { envEnabled: boolean; hasKey: boolean; optedInAt: string | null; active: boolean }; model: string; trips: Option[]; collections: Option[]; batches: Batch[]; /** Real spend from recorded token usage, at today's prices. */ spend: { items: number; inputTokens: number; cacheReadTokens: number; outputTokens: number; usd: number; pricesAsOf: string }; rawRetentionDays: number }) {
  const [pending, start] = useTransition();
  const [scopeKind, setScopeKind] = useState<BackfillScope["kind"]>("all");
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [from, setFrom] = useState("2000-01-01");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const scope = (): BackfillScope =>
    scopeKind === "trip" ? { kind: "trip", tripId } : scopeKind === "collection" ? { kind: "collection", collectionId } : scopeKind === "range" ? { kind: "range", from, to } : { kind: "all" };
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
          <dt className="text-muted">Spent so far</dt><dd>{spend.items === 0 ? "nothing yet" : `about $${spend.usd.toFixed(2)} for ${spend.items} item${spend.items === 1 ? "" : "s"} (${(spend.inputTokens + spend.cacheReadTokens).toLocaleString()} input tokens, ${spend.cacheReadTokens.toLocaleString()} of them read from cache, ${spend.outputTokens.toLocaleString()} output; each item at the price of the model that answered it, as of ${spend.pricesAsOf}; re-described items count their latest answer only)`}</dd>
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
        <p className="font-medium">Describe the existing library (backfill, at half price through the Batches API)</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={scopeKind} onChange={(e) => { setScopeKind(e.target.value as BackfillScope["kind"]); setPreview(null); }} className={select} aria-label="Scope">
            <option value="all">Everything not yet described</option>
            <option value="trip">One trip</option>
            <option value="collection">One collection</option>
            <option value="range">A date range</option>
          </select>
          {scopeKind === "trip" && (
            <select value={tripId} onChange={(e) => setTripId(e.target.value)} className={select} aria-label="Trip">
              {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          )}
          {scopeKind === "collection" && (
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className={select} aria-label="Collection">
              {collections.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
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
            <p className="text-muted">Sent per item: {preview.sends.join("; ")}. Opted-out and already described items are skipped.</p>
            <p className="text-muted">
              {preview.excluded.inScope} item{preview.excluded.inScope === 1 ? "" : "s"} in scope: {preview.excluded.described} already described, {preview.excluded.optedOutSelf} opted out, {preview.excluded.optedOutInherited} opted out through a trip or collection, {preview.estimate.items} would be sent. Items whose files cannot be read are skipped at submission and counted below.
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
            {batches.map((b) => (
              <li key={b.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {new Date(b.createdAt).toLocaleString("en-US")} · {b.scope}{b.parentId ? " (continued)" : ""} · {b.requested} requested{b.status !== "SUBMITTED" && <> · {b.succeeded} described, {b.errored} failed, {b.skipped} skipped{b.skippedReasons ? ` (${describeSkips(b.skippedReasons)})` : ""}</>} · <span className="text-muted">{b.status.toLowerCase()}</span>
                </span>
                {b.status === "SUBMITTED" && <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => cancelBackfill(b.id))}>Cancel</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
