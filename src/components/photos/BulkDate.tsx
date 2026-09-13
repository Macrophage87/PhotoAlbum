"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Input, Label } from "@/components/ui";
import { describeDatePlan, isEmptyPlan, type DatePlan } from "@/lib/photos/bulk-date";
import { previewBulkDate, bulkSetDate } from "@/app/photos/bulk-actions";
import { formatTaken } from "./LightboxInfo";

type Row = { id: string; label: string; before: { at: string; tzOffsetMin: number } | null; after: { at: string; tzOffsetMin: number } };

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Correcting a run of dates in one go.
 *
 * Two shapes of mistake turn up on a timeline and neither is a photo-by-photo job: a camera whose clock was wrong by
 * a fixed amount, and a set of scans or exports that all took the date of the day they were made. So the panel offers
 * exactly those two corrections, and shows what they do to the first few items before anything is written.
 */
export function BulkDate({ ids, onDone }: { ids: string[]; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<"day" | "shift">("day");
  const [day, setDay] = useState("");
  const [keepTime, setKeepTime] = useState(true);
  const [years, setYears] = useState(0);
  const [months, setMonths] = useState(0);
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [cached, setCached] = useState<{ key: string; data: { rows: Row[]; count: number; skipped: number } } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const plan: DatePlan | null =
    mode === "day"
      ? /^\d{4}-\d{2}-\d{2}$/.test(day) ? { mode: "day", day, keepTime } : null
      : { mode: "shift", years, months, days, minutes: hours * 60 + minutes };
  const ready = plan !== null && !isEmptyPlan(plan) && ids.length > 0;
  const planKey = plan ? JSON.stringify(plan) : "";

  // Show what the correction does as it is typed; nothing is written until the member applies it. The reading is
  // kept against the plan it was taken for, so an edited plan shows nothing rather than the last plan's answer.
  const preview = cached && cached.key === planKey ? cached.data : null;
  useEffect(() => {
    if (!ready || !planKey) return;
    let live = true;
    const t = setTimeout(() => {
      previewBulkDate(ids, JSON.parse(planKey) as DatePlan)
        .then((data) => { if (live) setCached({ key: planKey, data }); })
        .catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [ids, planKey, ready]);

  const apply = () =>
    start(async () => {
      if (!plan) return;
      setMessage(null);
      const r = await bulkSetDate(ids, plan);
      if (r.n === 0) { setMessage("Nothing was changed — none of the selected items could take that date."); return; }
      onDone(`${r.n} date${r.n === 1 ? "" : "s"} corrected${r.skipped ? `, ${r.skipped} left alone` : ""}.`);
    });

  const field = (label: string, value: number, set: (n: number) => void) => (
    <label className="text-xs text-muted">
      <span className="block">{label}</span>
      <input type="number" value={value} onChange={(e) => set(num(e.target.value))} className="mt-0.5 h-8 w-16 rounded-theme border border-border bg-surface px-2 text-sm text-text" />
    </label>
  );

  return (
    <div className="mb-4 rounded-theme border border-border bg-surface p-3 space-y-3 max-w-2xl" data-testid="bulk-date">
      <p className="text-sm">Fix the dates on {ids.length} selected item{ids.length === 1 ? "" : "s"}.</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="bulk-date-mode" checked={mode === "day"} onChange={() => setMode("day")} />
          Move them to a day
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="bulk-date-mode" checked={mode === "shift"} onChange={() => setMode("shift")} />
          Shift them by the same amount
        </label>
      </div>
      {mode === "day" ? (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="bulk-date-day">Day</Label>
            <Input id="bulk-date-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
          </div>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={keepTime} onChange={(e) => setKeepTime(e.target.checked)} />
            Keep each one&apos;s time of day
          </label>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          {field("Years", years, setYears)}
          {field("Months", months, setMonths)}
          {field("Days", days, setDays)}
          {field("Hours", hours, setHours)}
          {field("Minutes", minutes, setMinutes)}
          <p className="text-xs text-muted pb-2">Negative numbers move them back: a camera reset to 2002 needs a shift forward.</p>
        </div>
      )}
      {plan && !isEmptyPlan(plan) && <p className="text-sm text-muted">{describeDatePlan(plan)}.</p>}
      {preview && (
        <div className="rounded-theme border border-border bg-surface-alt p-2 text-xs space-y-1" data-testid="bulk-date-preview">
          {preview.rows.map((row) => (
            <p key={row.id} className="truncate">
              <span className="font-medium">{row.label}</span>
              {": "}
              {row.before ? formatTaken(row.before.at, row.before.tzOffsetMin) : "no date"} → <b>{formatTaken(row.after.at, row.after.tzOffsetMin)}</b>
            </p>
          ))}
          <p className="text-muted">
            {preview.count} item{preview.count === 1 ? "" : "s"} would change
            {preview.skipped > 0 && `, ${preview.skipped} left alone (a shift needs a date to shift)`}.
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!ready || pending || preview?.count === 0} onClick={apply}>{pending ? "Correcting…" : "Correct these dates"}</Button>
        <Button size="sm" variant="ghost" onClick={() => onDone("")}>Cancel</Button>
      </div>
      <p className="text-xs text-muted">Corrected dates are recorded as set by you, and the items move to whichever trip and activity the new date falls in.</p>
      {message && <p role="alert" className="text-xs text-red-800">{message}</p>}
    </div>
  );
}
