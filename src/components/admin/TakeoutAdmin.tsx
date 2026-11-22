"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocalTime } from "@/components/time/useLocalTime";
import { Button, Card } from "@/components/ui";
import { deleteTakeoutArchive, markTakeoutImportReviewed, startTakeoutImport } from "@/app/admin/actions";

export type ArchiveRow = { name: string; bytes: number; modifiedAt: string };
export type ImportRow = { id: string; archiveName: string; status: "RUNNING" | "ENDED" | "FAILED"; imported: number; skipped: number; failed: number; repaired: number; collectionsCreated: number; startedAt: string; endedAt: string | null; report: { albums?: { title: string; items: number; created: boolean }[]; duplicates?: number; unsupported?: number; noSidecar?: number; inTrash?: number; total?: number; failures?: { file: string; reason: string }[]; repairs?: string[] } | null; /** The member the photos were imported for, when not whoever started it. */ ownerName?: string | null; /** How many of the photos it brought in are still unreviewed. */ unreviewed?: number };
export type MemberOption = { id: string; label: string };

/** How often a page with an import running asks the server for its counts again. */
export const PROGRESS_POLL_MS = 4000;

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export function TakeoutAdmin({ configured, dir, archives, imports, members = [], meId = "" }: { configured: boolean; dir: string | null; archives: ArchiveRow[]; imports: ImportRow[]; /** Who an import can be for (#29); the admin running it is the default. */ members?: MemberOption[]; meId?: string }) {
  const stamp = useLocalTime();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const running = imports.some((i) => i.status === "RUNNING");
  // While an import runs its counts change on the server every few files; the page asks for them again until it ends.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), PROGRESS_POLL_MS);
    return () => clearInterval(t);
  }, [running, router]);
  const act = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setNotice(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });

  if (!configured) {
    return <p className="text-sm text-muted">Not configured. Set IMPORT_INBOX_DIR (the compose file mounts the <code>imports</code> volume at /data/imports) and copy Takeout zip files there to import them here.</p>;
  }
  return (
    <div className="space-y-4" data-testid="takeout-admin">
      <p className="text-sm text-muted">
        Export from Google Takeout with only Google Photos selected, copy the zip files into <code>{dir}</code> on the server, then import them here one at a time. Dates, places, descriptions and albums come across, and albums become private collections. A photo already in the album is not duplicated: instead the export fills in whatever it is still missing, which is how photos uploaded from a phone get their place back, since Android removes it on the way out.
      </p>
      {notice && <p role="status" className="text-sm rounded-theme bg-surface-alt p-3">{notice}</p>}
      {error && <p role="alert" className="text-sm rounded-theme bg-red-50 border border-red-200 text-red-900 p-3">{error}</p>}
      {archives.length === 0 ? (
        <p className="text-sm text-muted">No archives in the inbox.</p>
      ) : (
        <Card className="divide-y divide-border">
          {archives.map((a) => {
            // imports come newest first, so this is the latest run of this archive.
            const last = imports.find((i) => i.archiveName === a.name);
            const importing = last?.status === "RUNNING";
            const finished = last?.status === "ENDED";
            const owner = owners[a.name] ?? meId;
            const remove = (message: string) => { if (confirm(message)) act(async () => { const refused = await deleteTakeoutArchive(a.name); if (refused) throw new Error(refused); }); };
            return (
              <div key={a.name} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm" data-testid="takeout-archive-row">
                <div className="min-w-0">
                  <div className="font-medium truncate">{a.name}</div>
                  <div className="text-muted">{size(a.bytes)} · copied {stamp(a.modifiedAt, "date")}</div>
                  {finished && (
                    <div className="text-muted mt-1" data-testid="takeout-delete-prompt">
                      Imported {stamp(last.endedAt ?? last.startedAt, "date")}. Once you have looked over its photos, delete this copy: it is an unencrypted copy of the Google export.
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {members.length > 1 && (
                    <label className="flex items-center gap-1 text-muted">
                      Whose photos are these?
                      <select className="h-9 rounded-theme border border-border bg-surface px-2 text-sm" value={owner} disabled={pending || running} onChange={(e) => setOwners((o) => ({ ...o, [a.name]: e.target.value }))}>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.id === meId ? `${m.label} (you)` : m.label}</option>)}
                      </select>
                    </label>
                  )}
                  <Button size="sm" disabled={pending || running} onClick={() => act(() => startTakeoutImport(a.name, owner || undefined))}>Import</Button>
                  {finished ? (
                    <Button size="sm" variant="danger" disabled={pending} onClick={() => remove(`Delete ${a.name} from the inbox now? Its photos are in the album; this removes only the copy of the export on the server.`)}>Reviewed, delete the archive now</Button>
                  ) : (
                    <Button size="sm" variant="danger" disabled={pending || importing} onClick={() => remove(`Delete ${a.name} from the inbox? It is an unencrypted copy of your Google export; delete it once its photos are in the album.`)}>Delete</Button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
      {imports.length > 0 && (
        <div>
          <h3 className="font-medium mb-2">Imports</h3>
          <Card className="divide-y divide-border">
            {imports.map((i) => (
              <div key={i.id} className="p-3 text-sm space-y-1" data-testid="takeout-import" data-status={i.status}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{i.archiveName}</span>
                  <span className="text-muted">{i.status === "RUNNING" ? "in progress" : i.status === "ENDED" ? "done" : "failed"} · started {stamp(i.startedAt)}{i.ownerName ? ` · for ${i.ownerName}` : ""}</span>
                </div>
                {i.status === "RUNNING" && (
                  <div data-testid="takeout-progress" aria-live="polite">
                    {i.report?.total !== undefined ? `${Math.min(i.imported + i.skipped + i.failed, i.report.total)} of ${i.report.total} photos and videos looked at so far` : "Reading the archive…"}
                  </div>
                )}
                <div className="text-muted">
                  {i.imported} imported · {i.skipped} skipped{i.report?.duplicates ? ` (${i.report.duplicates} already in the album)` : ""}{i.report?.inTrash ? ` (${i.report.inTrash} in the trash, left there)` : ""}{i.report?.unsupported ? ` (${i.report.unsupported} in formats the album does not take)` : ""} · {i.repaired} repaired · {i.failed} failed · {i.collectionsCreated} private collection{i.collectionsCreated === 1 ? "" : "s"} created
                  {i.report?.noSidecar ? ` · ${i.report.noSidecar} without Google metadata` : ""}
                </div>
                {i.report?.albums && i.report.albums.length > 0 && <div className="text-muted">Albums: {i.report.albums.map((a) => `${a.title} (${a.items}${a.created ? "" : ", existing"})`).join(", ")}</div>}
                {i.report?.repairs && i.report.repairs.length > 0 && (
                  <details className="text-muted"><summary>{i.repaired} photo{i.repaired === 1 ? "" : "s"} filled in from the export</summary><ul className="list-disc ml-5">{i.report.repairs.map((r, n) => <li key={n}>{r}</li>)}</ul></details>
                )}
                {i.status !== "RUNNING" && (i.unreviewed ?? 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-muted">{i.unreviewed} of its photos are waiting in the Unreviewed list.</span>
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(async () => { const n = await markTakeoutImportReviewed(i.id); setNotice(`${n} photo${n === 1 ? "" : "s"} marked reviewed.`); })}>
                      Mark this import&apos;s {i.unreviewed} photo{i.unreviewed === 1 ? "" : "s"} as reviewed
                    </Button>
                  </div>
                )}
                {i.report?.failures && i.report.failures.length > 0 && (
                  <details className="text-muted"><summary>{i.report.failures.length} failure{i.report.failures.length === 1 ? "" : "s"}</summary><ul className="list-disc ml-5">{i.report.failures.map((f, n) => <li key={n}>{f.file}: {f.reason}</li>)}</ul></details>
                )}
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
