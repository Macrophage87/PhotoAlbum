"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { resetPhotoDateToCamera, setPhotoDate } from "@/app/photos/[id]/actions";

/**
 * The photo page's date box. Its answers are read rather than thrown away: a year out of range, or a scan with no
 * camera date to go back to, is said out loud instead of the page quietly showing the old date again.
 */
export function DateTakenForm({ photoId, initial, hint }: { photoId: string; initial: string; hint: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (act: () => ReturnType<typeof setPhotoDate>) =>
    start(async () => {
      setMessage(null);
      const r = await act();
      if (!r.ok) { setMessage(r.message); return; }
      router.refresh();
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run(() => setPhotoDate(photoId, fd));
      }}
      className="mt-3 pt-3 border-t border-border space-y-2"
    >
      <div className="text-xs font-medium">Date taken</div>
      <p className="text-xs text-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        <input key={initial} type="datetime-local" name="takenAt" aria-label="Date taken" defaultValue={initial} required className="h-8 rounded-theme border border-border bg-surface text-text [color-scheme:light] px-2 text-sm" />
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>Save date</Button>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => resetPhotoDateToCamera(photoId))}>Use camera date</Button>
      </div>
      {message && <p role="alert" className="text-xs text-red-800">{message}</p>}
    </form>
  );
}
