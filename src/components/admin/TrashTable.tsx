"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button, Card } from "@/components/ui";
import { deleteFromTrash, restoreFromTrash } from "@/app/admin/trash/actions";

export type TrashItem = {
  id: string;
  label: string;
  thumbUrl: string | null;
  trashedAt: string;
  trashedBy: string | null;
  uploadedBy: string | null;
  reason: string;
  /** Someone in the photo asked for it to go: never restore one of these without asking them. */
  removalRequest: boolean;
  trip: { slug: string; title: string } | null;
};

export function TrashTable({ items }: { items: TrashItem[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const ids = [...selected];
  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });
  const done = (verb: string) => (n: number) => { setSelected(new Set()); setMessage(`${n} item${n === 1 ? "" : "s"} ${verb}.`); };

  // The empty state still carries the message: restoring or deleting the last item is exactly when an admin most
  // wants to be told it worked.
  if (!items.length) {
    return (
      <div className="space-y-3">
        {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
        <Card className="p-6 text-muted">The trash is empty.</Card>
      </div>
    );
  }

  const askedFor = ids.filter((id) => items.find((i) => i.id === id)?.removalRequest).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Trash actions">
        <span className="text-sm text-muted">{ids.length ? `${ids.length} selected` : `${items.length} item${items.length === 1 ? "" : "s"} in the trash`}</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ids.length || pending}
          onClick={() => {
            if (askedFor > 0 && !window.confirm(`${askedFor} of these was taken down because someone in it asked. Put ${askedFor === 1 ? "it" : "them"} back into the album anyway?`)) return;
            start(async () => done("restored")(await restoreFromTrash(ids)));
          }}
        >
          Restore
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!ids.length || pending}
          onClick={() => {
            if (!window.confirm(`Delete ${ids.length} item${ids.length === 1 ? "" : "s"} for good? The file and everything the album knows about ${ids.length === 1 ? "it" : "them"} are removed from this server. This cannot be undone.`)) return;
            start(async () => done("deleted for good")(await deleteFromTrash(ids)));
          }}
        >
          Delete for good
        </Button>
        {ids.length < items.length ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Select all</Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        )}
      </div>
      {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Card className="p-3 flex items-start gap-3">
              <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${item.label}`} className="mt-1" />
              {item.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.thumbUrl} alt="" width={64} height={64} className="w-16 h-16 object-cover rounded-theme bg-surface-alt" />
              ) : (
                <div className="w-16 h-16 rounded-theme bg-surface-alt grid place-items-center text-xs text-muted">video</div>
              )}
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/photos/${item.id}`} className="font-medium text-primary hover:underline truncate">{item.label}</Link>
                  {item.removalRequest && <Badge tone="primary">someone asked</Badge>}
                  {item.trip && <span className="text-muted">from {item.trip.title}</span>}
                </div>
                <p className="text-muted">{item.reason}</p>
                <p className="text-muted text-xs">
                  Trashed {item.trashedBy ? `by ${item.trashedBy} ` : ""}on {new Date(item.trashedAt).toLocaleString("en-US")}
                  {item.uploadedBy ? ` · uploaded by ${item.uploadedBy}` : ""}
                </p>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
