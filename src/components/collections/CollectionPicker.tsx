"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { togglePhotoInCollection } from "@/app/collections/actions";

type Option = { id: string; slug: string; title: string; member: boolean };

/** Checkbox list of every collection with this photo's membership; toggling saves immediately. */
export function CollectionPicker({ photoId, collections }: { photoId: string; collections: Option[] }) {
  const [state, setState] = useState<Option[]>(collections);
  const [pending, start] = useTransition();
  if (state.length === 0) return <p className="text-sm text-muted">No collections yet. <Link href="/collections/new" className="text-primary hover:underline">Create one</Link>.</p>;
  const toggle = (id: string, member: boolean) => {
    setState((prev) => prev.map((c) => (c.id === id ? { ...c, member } : c)));
    start(async () => {
      try {
        await togglePhotoInCollection(photoId, id, member);
      } catch {
        setState((prev) => prev.map((c) => (c.id === id ? { ...c, member: !member } : c)));
      }
    });
  };
  return (
    <ul className="space-y-1.5" aria-busy={pending}>
      {state.map((c) => (
        <li key={c.id} className="flex items-center gap-2 text-sm">
          <input id={`col-${c.id}`} type="checkbox" checked={c.member} onChange={(e) => toggle(c.id, e.target.checked)} />
          <label htmlFor={`col-${c.id}`} className="flex-1 cursor-pointer">{c.title}</label>
          {c.member && <Link href={`/collections/${c.slug}`} className="text-xs text-primary hover:underline">Open</Link>}
        </li>
      ))}
    </ul>
  );
}
