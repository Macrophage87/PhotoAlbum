"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Select } from "@/components/ui";
import { tagPet } from "@/app/people/actions";

type Pet = { id: string; name: string; species: string };

/** Members tag a pet on a photo by hand; the pet list is fetched when the control opens. */
export function PetTagger({ photoId, onDone, dark = false }: { photoId: string; onDone?: () => void; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pets, setPets] = useState<Pet[] | null>(null);
  const [choice, setChoice] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  useEffect(() => {
    if (!open || pets) return;
    fetch("/api/people/pets").then((r) => (r.ok ? r.json() : { pets: [] })).then((b) => setPets(b.pets ?? [])).catch(() => setPets([]));
  }, [open, pets]);
  const cls = dark ? "text-white/80 hover:text-white underline underline-offset-2" : "text-primary hover:underline";
  if (!open) return <button type="button" className={`text-xs ${cls}`} onClick={() => setOpen(true)}>Tag a pet</button>;
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {pets === null ? (
        <span className={dark ? "text-white/60" : "text-muted"}>Loading…</span>
      ) : pets.length === 0 ? (
        <span className={dark ? "text-white/60" : "text-muted"}>No pets yet. Add one on the People page.</span>
      ) : (
        <>
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} className="h-8 text-xs" aria-label="Pet">
            <option value="">Which pet?</option>
            {pets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
          <Button size="sm" disabled={!choice || pending} onClick={() => start(async () => { await tagPet(photoId, choice); setOpen(false); setChoice(""); onDone?.(); router.refresh(); })}>Tag</Button>
        </>
      )}
      <button type="button" className={cls} onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
