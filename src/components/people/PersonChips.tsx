"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";
import { nameFace, untagPerson } from "@/app/people/actions";
import { PetTagger } from "./PetTagger";

export type ChipFace = { id: string; status: string; hand: boolean; person: { id: string; name: string; kind: string } | null; proposedPerson: { id: string; name: string } | null };

/** Members-only name chips for a photo, with remove, and a picker to name an unnamed face by hand. Never rendered for anonymous or share-link viewers. */
export function PersonChips({ photoId, faces, people }: { photoId: string; faces: ChipFace[]; people: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [naming, setNaming] = useState<string | null>(null);
  const router = useRouter();
  const named = faces.filter((f) => f.person && f.status === "CONFIRMED");
  const unnamed = faces.filter((f) => !f.person && f.status !== "PROPOSED" && !f.hand);
  const seen = new Set<string>();
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {named.filter((f) => !seen.has(f.person!.id) && seen.add(f.person!.id)).map((f) => (
        <span key={f.id} className="inline-flex items-center rounded-full bg-primary/10 text-primary">
          <Link href={`/people/${f.person!.id}`} className="pl-2.5 py-0.5 hover:underline">{f.person!.name}</Link>
          <button type="button" aria-label={`Remove ${f.person!.name}`} disabled={pending} className="px-1.5 py-0.5 hover:text-red-700" onClick={() => start(async () => { await untagPerson(photoId, f.person!.id); router.refresh(); })}>×</button>
        </span>
      ))}
      {unnamed.map((f, i) =>
        naming === f.id ? (
          <Select key={f.id} aria-label="Who is this?" className="h-7 text-xs w-auto" defaultValue="" disabled={pending} onChange={(e) => { const v = e.target.value; if (v) start(async () => { await nameFace(f.id, v); setNaming(null); router.refresh(); }); }}>
            <option value="">Who is this?</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        ) : (
          <button key={f.id} type="button" className="rounded-full bg-surface-alt text-muted px-2.5 py-0.5 hover:bg-border" onClick={() => setNaming(f.id)}>unnamed face{unnamed.length > 1 ? ` ${i + 1}` : ""}</button>
        ),
      )}
      <PetTagger photoId={photoId} />
    </div>
  );
}
