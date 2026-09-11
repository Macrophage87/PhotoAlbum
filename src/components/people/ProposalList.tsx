"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui";
import { confirmProposal, rejectProposalAction } from "@/app/people/actions";
import { FaceThumb } from "./FaceThumb";

export type Proposal = { faceId: string; photo: { id: string; updatedAt: string | Date }; box: [number, number, number, number]; person: { id: string; name: string; kind: string }; label: string; childhood: boolean };

/** "Probably Grandma Jo?" rows with confirm and reject. Members only. */
export function ProposalList({ proposals }: { proposals: Proposal[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!proposals.length) return null;
  const act = (fn: () => Promise<void>) => start(async () => { await fn(); router.refresh(); });
  return (
    <ul className="space-y-2">
      {proposals.map((p) => (
        <li key={p.faceId} className="flex flex-wrap items-center gap-3 rounded-theme border border-border bg-surface p-3 text-sm" data-testid="proposal">
          {p.box[2] < 1 ? <FaceThumb photo={{ id: p.photo.id, updatedAt: new Date(p.photo.updatedAt) }} box={p.box} size={56} /> : null}
          <span className="flex-1 min-w-40">
            Probably <Link href={`/people/${p.person.id}`} className="font-medium text-primary hover:underline">{p.person.name}</Link>?
            <span className="block text-xs text-muted">{p.label}{p.childhood ? " · childhood match, please check" : ""}</span>
          </span>
          <Button size="sm" disabled={pending} onClick={() => act(() => confirmProposal(p.faceId))}>Yes, that&apos;s {p.person.name.split(" ")[0]}</Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => rejectProposalAction(p.faceId))}>No</Button>
        </li>
      ))}
    </ul>
  );
}
