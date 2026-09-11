"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui";
import { deleteAllFaceData, setFaceDetectionOptIn } from "@/app/people/actions";

export function FacesAdmin({ gates, counts }: { gates: { sidecar: boolean; envEnabled: boolean; optedInAt: string | null; active: boolean; retentionDays: number }; counts: { templates: number; unnamed: number; people: number; nextPurge: string | null } }) {
  const [pending, start] = useTransition();
  return (
    <div className="rounded-theme border border-border bg-surface p-4 space-y-3 text-sm">
      <p className="font-medium">What face detection does, once both switches are on</p>
      <ul className="list-disc pl-5 space-y-1 text-muted">
        <li>Computes and stores a face template (a list of numbers, not a picture) for <b>every face in every photo</b>, including children, guests and people who will never be named.</li>
        <li>Templates stay on this server, in the database, and are never sent anywhere. The sidecar keeps nothing.</li>
        <li>Faces nobody names are deleted after {gates.retentionDays} days. Naming a group and letting it recognise someone is a separate, per-person decision that only an admin can make.</li>
      </ul>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt className="text-muted">ML sidecar</dt><dd>{gates.sidecar ? "configured" : "not configured (set ML_URL and ML_TOKEN)"}</dd>
        <dt className="text-muted">Operator flag</dt><dd>{gates.envEnabled ? "FACE_INDEXING_ENABLED is on" : "FACE_INDEXING_ENABLED is off"}</dd>
        <dt className="text-muted">Admin opt-in</dt><dd>{gates.optedInAt ? `on since ${new Date(gates.optedInAt).toLocaleDateString("en-US")}` : "off"}</dd>
        <dt className="text-muted">Stored templates</dt><dd>{counts.templates} ({counts.unnamed} unnamed{counts.nextPurge ? `, oldest purged by ${new Date(counts.nextPurge).toLocaleDateString("en-US")}` : ""}) · {counts.people} people</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        {gates.optedInAt ? (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(() => setFaceDetectionOptIn(false))}>Turn face detection off</Button>
        ) : (
          <Button size="sm" disabled={pending || !gates.sidecar || !gates.envEnabled} onClick={() => start(() => setFaceDetectionOptIn(true))}>Turn on face detection</Button>
        )}
        <Button variant="danger" size="sm" disabled={pending || counts.templates === 0 && counts.unnamed === 0} onClick={() => { if (window.confirm("Delete every face template, group and match? People and their names stay. This cannot be undone.")) start(() => deleteAllFaceData()); }}>Delete all face data</Button>
        <span className={`text-xs rounded-full px-2 py-0.5 ${gates.active ? "bg-emerald-100 text-emerald-800" : "bg-surface-alt text-muted"}`}>{gates.active ? "scanning new photos" : "not scanning"}</span>
      </div>
    </div>
  );
}
