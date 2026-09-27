"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { rebindStorage } from "@/app/admin/actions";

/**
 * Said when the storage folder and this database may not be the same album's. Re-binding is for a genuine move or
 * restore: it is refused unless this database accounts for what the folder holds.
 */
export function StorageIdentityNotice({ problem, unknownFiles }: { problem: string; unknownFiles: boolean }) {
  const [pending, start] = useTransition();
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="rounded-theme border border-red-300 bg-red-50 p-3 text-sm text-red-900 space-y-2" data-testid="install-identity-problem">
      <p className="font-medium">{unknownFiles ? "This storage holds files this album's database does not know" : "The storage folder and this database may not be the same album's"}</p>
      <p>{problem} Until it is put right, nothing in the storage folder is cleaned up or moved. See &ldquo;The install marker&rdquo; in the deployment guide.</p>
      <p>If this album was moved or restored, and this is its database, re-bind the storage to it. That is refused unless this database has a photo for nearly every folder in the storage.</p>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          if (!confirm("Re-bind the storage folder to this database? Do this only if no other album uses the same folder.")) return;
          start(async () => {
            try {
              const r = await rebindStorage();
              setAnswer({ ok: r.ok, text: r.message });
            } catch (e) {
              setAnswer({ ok: false, text: e instanceof Error ? e.message : "Something went wrong" });
            }
          });
        }}
      >
        Re-bind the storage to this database
      </Button>
      {answer && <p role={answer.ok ? "status" : "alert"} className="font-medium">{answer.text}</p>}
    </div>
  );
}
