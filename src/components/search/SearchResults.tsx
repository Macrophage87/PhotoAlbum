"use client";

import Link from "next/link";
import { Lightbox, useLightbox, type LightboxPhoto } from "@/components/photos/Lightbox";
import { useSelectionContext } from "@/components/photos/selection";

export type SearchResult = LightboxPhoto & { thumbUrl: string; snippet: string; tripSlug: string | null; tripTitle: string | null; when: string | null };

function Snippet({ text }: { text: string }) {
  // The database marks matches with [[ ]]; render those as <mark> without ever treating the text as HTML.
  const parts = text.split(/(\[\[.*?\]\])/g).filter(Boolean);
  return (
    <span>
      {parts.map((part, i) => (part.startsWith("[[") && part.endsWith("]]") ? <mark key={i} className="bg-accent/40 rounded px-0.5">{part.slice(2, -2)}</mark> : <span key={i}>{part}</span>))}
    </span>
  );
}

export function SearchResults({ results, member }: { results: SearchResult[]; member: boolean }) {
  const lb = useLightbox();
  // Inside a SelectionProvider (members), the "Select photos" bar turns each result into a checkbox for add-to-trip and add-to-collection.
  const ctx = useSelectionContext();
  const selecting = ctx?.active ?? false;
  return (
    <>
      <ul className="divide-y divide-border">
        {results.map((r, i) => (
          <li key={r.id} className="flex gap-4 py-3">
            <button onClick={() => (selecting ? ctx?.toggle(r.id) : lb.open(i))} className={`relative shrink-0 w-24 h-24 rounded-theme overflow-hidden bg-surface-alt border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selecting && ctx?.selected.has(r.id) ? "ring-4 ring-primary ring-inset" : ""}`} aria-label={selecting ? `Select ${r.alt}` : `Open ${r.alt}`} aria-pressed={selecting ? ctx?.selected.has(r.id) : undefined}>
              {selecting && <span className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 border-white flex items-center justify-center text-[10px] ${ctx?.selected.has(r.id) ? "bg-primary text-primary-fg" : "bg-black/40"}`} aria-hidden="true">{ctx?.selected.has(r.id) ? "✓" : ""}</span>}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
            </button>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium truncate">{r.title ?? r.caption ?? r.alt}</p>
              <p className="text-muted mt-0.5"><Snippet text={r.snippet} /></p>
              <p className="text-xs text-muted mt-1 flex flex-wrap gap-x-2">
                {r.tripSlug && <Link href={`/trips/${r.tripSlug}`} className="hover:underline">{r.tripTitle}</Link>}
                {r.when && <span>{r.when}</span>}
                {r.youtubeId && <span>YouTube video</span>}
                {r.videoUrl && <span>Clip</span>}
                {member && r.uploadedBy && <span>Uploaded by {r.uploadedBy}</span>}
                {member && <Link href={`/photos/${r.id}`} className="text-primary hover:underline">Details</Link>}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {lb.index !== null && <Lightbox photos={results} index={lb.index} onClose={lb.close} onNavigate={lb.open} />}
    </>
  );
}
