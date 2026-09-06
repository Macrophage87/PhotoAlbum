"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { RELATION_LABEL } from "@/lib/photos/relations";

export type LinkCandidate = { id: string; thumbUrl: string; caption: string | null; originalName: string; takenAt: string | null };

/** Pick another photo from the same trip and describe how the two relate. */
export function PhotoLinkEditor({ candidates, action }: { candidates: LinkCandidate[]; action: (fd: FormData) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((c) => (c.caption ?? "").toLowerCase().includes(q) || c.originalName.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  if (!open)
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={candidates.length === 0} title={candidates.length === 0 ? "No other photos on this trip yet" : undefined}>
        Link another photo
      </Button>
    );

  return (
    <form action={action} className="space-y-3 rounded-theme border border-border p-3">
      <Input placeholder="Filter by caption or file name" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 text-sm" />
      <div className="grid grid-cols-4 gap-1.5 max-h-56 overflow-y-auto">
        {filtered.slice(0, 200).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setPicked(c.id)}
            className={`aspect-square rounded overflow-hidden border-2 ${picked === c.id ? "border-primary" : "border-transparent"}`}
            title={c.caption ?? c.originalName}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
          </button>
        ))}
        {filtered.length === 0 && <p className="col-span-4 text-xs text-muted">No matches.</p>}
      </div>
      <input type="hidden" name="otherId" value={picked ?? ""} />
      <div className="flex gap-2">
        <Select name="relation" defaultValue="RELATED" className="h-8 text-sm">
          {Object.entries(RELATION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input name="note" placeholder="Note (optional)" className="h-8 text-sm" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!picked}>
          Link
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
