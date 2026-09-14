"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { foldDuplicatePhotos } from "@/app/admin/actions";

export type DuplicateRow = { contentHash: string; ids: string[]; thumbUrl: string | null; name: string };

/**
 * The same file, in the album more than once. Not similar photographs — the same bytes, which happens when one is
 * uploaded from a phone and again from the laptop it was copied to, or when two people put in the picture that went
 * round the family.
 */
export function DuplicatesPanel({ rows, total }: { rows: DuplicateRow[]; total: number }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const router = useRouter();

  if (!rows.length) {
    return (
      <Card className="p-5">
        <h2 className="font-display text-xl font-semibold">Identical copies</h2>
        {/* Folding empties this panel, so what it did has to be said here too — and said out loud, not merely shown. */}
        <p role="status" className="text-muted mt-1 text-sm">{done ?? "No photograph is in the album twice."}</p>
      </Card>
    );
  }

  return (
    <Card className="p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">Identical copies</h2>
          <p className="text-muted mt-1 text-sm">
            {total} {total === 1 ? "photograph is" : "photographs are"} in the album more than once — the same file,
            byte for byte. Folding them keeps the one that has been here longest, takes from the copies anything it
            was missing (a caption, a date, a place, a trip, a collection, a favourite), and puts the copies in the
            trash marked as duplicates, where they can still be got back.
          </p>
        </div>
        <Button
          disabled={pending}
          data-testid="fold-duplicates"
          onClick={() =>
            start(async () => {
              const r = await foldDuplicatePhotos();
              setDone(`${r.folded} ${r.folded === 1 ? "copy" : "copies"} folded into ${r.groups} ${r.groups === 1 ? "photograph" : "photographs"}.`);
              router.refresh();
            })
          }
        >
          {pending ? "Folding…" : "Fold them in"}
        </Button>
      </div>
      {done && <p role="status" className="text-sm rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 p-3">{done}</p>}
      <ul className="flex flex-wrap gap-3">
        {rows.map((r) => (
          <li key={r.contentHash} className="w-32">
            <Link href={`/photos/${r.ids[0]}`} className="block">
              {r.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.thumbUrl} alt={r.name} className="w-32 h-32 object-cover rounded-theme border border-border" />
              ) : (
                <div className="w-32 h-32 rounded-theme bg-surface-alt border border-border" />
              )}
            </Link>
            <p className="text-xs text-muted mt-1 truncate" title={r.name}>{r.name}</p>
            <p className="text-xs text-muted">{r.ids.length} copies</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
