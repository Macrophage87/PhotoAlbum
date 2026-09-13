"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { moveToDay, putInActivity } from "@/app/photos/activity-actions";

/** What a tile puts on the drag, and a drop target reads back off it. */
export const PHOTO_DRAG_TYPE = "application/x-album-photo";

export function photoFromDrag(e: React.DragEvent): string | null {
  return e.dataTransfer.getData(PHOTO_DRAG_TYPE) || e.dataTransfer.getData("text/plain") || null;
}

/**
 * Somewhere on the timeline a photograph can be dropped: an activity, a day, or the loose strip between them.
 *
 * The timeline is where a wrong filing is obvious — a photograph from the boat sitting under the morning walk,
 * because both happened at once and only a clock was consulted. Dragging it across says what a person knows and the
 * album could not: this one was the boat. Everything here is also reachable without a drag, from the selection bar
 * and the item's own page, because dragging is no use on a phone.
 */
export function TimelineDrop({ kind, target, label, children, className }: {
  kind: "activity" | "day" | "loose";
  /** An activity id, a day (YYYY-MM-DD), or nothing for the loose strip. */
  target: string | null;
  /** What to say once something lands here. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, start] = useTransition();

  const drop = (photoId: string) =>
    start(async () => {
      const r = kind === "day" && target ? await moveToDay(photoId, target) : await putInActivity(photoId, kind === "activity" ? target : null);
      setNote(r.ok ? `Moved to ${kind === "day" ? label : r.where}.` : r.message);
      if (r.ok) router.refresh();
      setTimeout(() => setNote(null), 4000);
    });

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes(PHOTO_DRAG_TYPE)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = photoFromDrag(e);
        if (id) drop(id);
      }}
      className={`${className ?? ""} ${over ? "outline outline-2 outline-primary outline-offset-2 rounded-theme" : ""}`}
      data-testid={`drop-${kind}`}
      data-drop-target={target ?? ""}
    >
      {children}
      {note && <p role="status" className="text-xs text-primary mt-1">{note}</p>}
    </div>
  );
}
