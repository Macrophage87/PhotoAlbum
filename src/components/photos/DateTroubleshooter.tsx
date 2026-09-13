"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { loadDateReport, applyReportedDate } from "@/app/photos/[id]/actions";
import type { DateReport } from "@/lib/photos/date-report";

const when = (iso: string | null, tzOffsetMin: number | null) => {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(at.getTime() + (tzOffsetMin ?? 0) * 60_000));
};

type Wire = Omit<DateReport, "current" | "witnesses"> & {
  current: { at: string | null; source: string | null; tzOffsetMin: number | null; setBy: string | null };
  witnesses: (Omit<DateReport["witnesses"][number], "at"> & { at: string | null })[];
};

/**
 * Why an item has the date it has. Every witness the album consulted, what each one says, and what it is worth —
 * so a print scanned last week that claims to be from last week can be understood and corrected rather than argued
 * with. Nothing here changes anything until a member takes one of the readings.
 */
export function DateTroubleshooter({ photoId }: { photoId: string }) {
  const router = useRouter();
  const [report, setReport] = useState<Wire | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      const r = await loadDateReport(photoId);
      if (!r) { setMessage("Could not read this item's date."); return; }
      setReport(JSON.parse(JSON.stringify(r)) as Wire);
      setOpen(true);
    });

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={load} disabled={pending}>
        {pending ? "Looking…" : "Where did this date come from?"}
      </Button>
    );
  }
  if (!report) return null;

  return (
    <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-3 text-sm" data-testid="date-report">
      <div className="flex items-start justify-between gap-2">
        <p>
          This item is dated <b>{when(report.current.at, report.current.tzOffsetMin) ?? "not at all"}</b>
          {report.current.source ? <> , from {report.current.source}</> : null}
          {report.current.setBy ? ` (${report.current.setBy})` : ""}.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
      {report.looksScanned && (
        <p className="rounded-theme border border-amber-300 bg-amber-50 text-amber-900 p-2">
          This looks like a scan: the file carries no capture time and nothing in its name looks like one, so the date below is when the file was made, not when the photograph was taken. Take one of the readings, or set the date by hand.
        </p>
      )}
      <ul className="divide-y divide-border rounded-theme border border-border bg-surface">
        {report.witnesses.map((w) => (
          <li key={w.key} className="p-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium">{w.label}</span>
            {w.current && <span className="text-xs rounded-full bg-surface-alt px-2 py-0.5">this is the one in use</span>}
            <span className="w-full text-xs text-muted">{w.note}</span>
            <span className="flex-1">{when(w.at, report.current.tzOffsetMin) ?? <span className="text-muted">nothing</span>}</span>
            {w.usable && w.at && !w.current && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setMessage(null);
                    const r = await applyReportedDate(photoId, w.at!);
                    if (!r.ok) { setMessage(r.message); return; }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                Use this
              </Button>
            )}
          </li>
        ))}
      </ul>
      {message && <p role="alert" className="text-red-800 text-xs">{message}</p>}
    </div>
  );
}
