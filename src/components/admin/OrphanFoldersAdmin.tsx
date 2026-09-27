"use client";

import { useState, useTransition } from "react";
import { useLocalTime } from "@/components/time/useLocalTime";
import { Button, Input, Label } from "@/components/ui";
import { emptyOldQuarantine, quarantineOrphanFolders } from "@/app/admin/actions";

export type QuarantineDayRow = { day: string; folders: number };

/**
 * Photo folders with no photo in this album, as the hourly check found them, and the quarantine they can be moved
 * to. Nothing here happens by itself: moving needs the count typed, and emptying only takes what has waited its
 * time in the quarantine.
 */
export function OrphanFoldersAdmin({ count, sample, checkedAt, quarantine, keepDays }: { count: number; sample: string[]; checkedAt: string | null; quarantine: QuarantineDayRow[]; keepDays: number }) {
  const stamp = useLocalTime();
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      setMessage(null);
      try {
        const r = await fn();
        setMessage({ ok: r.ok, text: r.message });
        if (r.ok) setTyped("");
      } catch (e) {
        setMessage({ ok: false, text: e instanceof Error ? e.message : "Something went wrong" });
      }
    });
  const inQuarantine = quarantine.reduce((n, d) => n + d.folders, 0);
  if (!count && !inQuarantine && !message) return null;
  return (
    <div className="space-y-3 text-sm" data-testid="orphan-folders">
      {count > 0 && (
        <div className="space-y-2">
          <p className="font-medium">{count} photo folder{count === 1 ? " has" : "s have"} no photo in this album</p>
          <p className="text-muted">
            Left behind by items deleted for good whose files were not removed, as found {checkedAt ? `on ${stamp(checkedAt, "date")}` : "by the hourly check"}. Moving them puts them in <code>quarantine/</code> in the storage folder, where they can still be copied back; nothing is deleted.
            {sample.length > 0 && <> For example: <code>{sample.slice(0, 5).join(", ")}</code>.</>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="orphan-confirm" className="mb-0">Type {count} to confirm</Label>
            <Input id="orphan-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="w-24 h-9" autoComplete="off" />
            <Button size="sm" variant="secondary" disabled={pending || typed.trim() !== String(count)} onClick={() => run(() => quarantineOrphanFolders(typed))}>Move to the quarantine</Button>
          </div>
        </div>
      )}
      {inQuarantine > 0 && (
        <div className="space-y-2">
          <p className="text-muted">In the quarantine: {quarantine.map((d) => `${d.folders} moved ${d.day}`).join(", ")}. Emptying it deletes only what has been there over {keepDays} days.</p>
          <Button size="sm" variant="danger" disabled={pending} onClick={() => { if (confirm(`Delete for good the folders that have been in the quarantine for over ${keepDays} days? This cannot be undone.`)) run(emptyOldQuarantine); }}>Empty quarantine older than {keepDays} days</Button>
        </div>
      )}
      {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-muted" : "rounded-theme bg-red-50 border border-red-200 text-red-900 p-3"}>{message.text}</p>}
    </div>
  );
}
