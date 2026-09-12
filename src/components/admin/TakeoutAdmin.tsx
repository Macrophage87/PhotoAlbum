"use client";

import { useState, useTransition } from "react";
import { Button, Card } from "@/components/ui";
import { deleteTakeoutArchive, startTakeoutImport } from "@/app/admin/actions";

export type ArchiveRow = { name: string; bytes: number; modifiedAt: string };
export type ImportRow = { id: string; archiveName: string; status: "RUNNING" | "ENDED" | "FAILED"; imported: number; skipped: number; failed: number; repaired: number; collectionsCreated: number; startedAt: string; endedAt: string | null; report: { albums?: { title: string; items: number; created: boolean }[]; duplicates?: number; unsupported?: number; noSidecar?: number; failures?: { file: string; reason: string }[]; repairs?: string[] } | null };

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export function TakeoutAdmin({ configured, dir, archives, imports }: { configured: boolean; dir: string | null; archives: ArchiveRow[]; imports: ImportRow[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const running = imports.some((i) => i.status === "RUNNING");
  const act = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
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
      {error && <p role="alert" className="text-sm rounded-theme bg-red-50 border border-red-200 text-red-900 p-3">{error}</p>}
      {archives.length === 0 ? (
        <p className="text-sm text-muted">No archives in the inbox.</p>
      ) : (
        <Card className="divide-y divide-border">
          {archives.map((a) => (
            <div key={a.name} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">{a.name}</div>
                <div className="text-muted">{size(a.bytes)} · copied {new Date(a.modifiedAt).toLocaleDateString("en-US")}</div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={pending || running} onClick={() => act(() => startTakeoutImport(a.name))}>Import</Button>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => { if (confirm(`Delete ${a.name} from the inbox? It is an unencrypted copy of your Google export; delete it once its photos are in the album.`)) act(() => deleteTakeoutArchive(a.name)); }}>Delete</Button>
              </div>
            </div>
          ))}
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
                  <span className="text-muted">{i.status === "RUNNING" ? "in progress" : i.status === "ENDED" ? "done" : "failed"} · started {new Date(i.startedAt).toLocaleString("en-US")}</span>
                </div>
                <div className="text-muted">
                  {i.imported} imported · {i.skipped} skipped{i.report?.duplicates ? ` (${i.report.duplicates} already in the album)` : ""} · {i.repaired} repaired · {i.failed} failed · {i.collectionsCreated} private collection{i.collectionsCreated === 1 ? "" : "s"} created
                  {i.report?.noSidecar ? ` · ${i.report.noSidecar} without Google metadata` : ""}
                </div>
                {i.report?.albums && i.report.albums.length > 0 && <div className="text-muted">Albums: {i.report.albums.map((a) => `${a.title} (${a.items}${a.created ? "" : ", existing"})`).join(", ")}</div>}
                {i.report?.repairs && i.report.repairs.length > 0 && (
                  <details className="text-muted"><summary>{i.repaired} photo{i.repaired === 1 ? "" : "s"} filled in from the export</summary><ul className="list-disc ml-5">{i.report.repairs.map((r, n) => <li key={n}>{r}</li>)}</ul></details>
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
