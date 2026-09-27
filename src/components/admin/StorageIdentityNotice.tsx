"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { rebindStorage } from "@/app/admin/actions";

type Kind = "unmarked" | "unclaimed" | "unknown-files" | "no-id" | "other-album" | "other-database" | "cannot-verify-database";
/** Another database's recent use of the folder, which keeps this one from claiming it until `until`. */
export type NoticeBlock = { minutesAgo: number; until: string } | "unreadable" | null;

/**
 * Said when the storage folder and this database may not be the same album's. What an admin can do depends on why:
 * for another database still using the folder (a staging copy sharing live's media, say) nothing, and a claim or
 * re-bind is offered only once that database has been silent long enough to be taken for gone.
 */
export function StorageIdentityNotice({ kind, problem, block, waitHours }: { kind: Kind; problem: string; block: NoticeBlock; waitHours: number }) {
  const [pending, start] = useTransition();
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const title =
    kind === "unclaimed" ? "This storage has not been claimed by this album yet"
    : kind === "unknown-files" ? "This storage holds files this album's database does not know"
    : kind === "cannot-verify-database" ? "The album cannot check which database this is"
    : kind === "other-database" ? "The storage folder is bound to another database"
    : "The storage folder and this database may not be the same album's";
  const canAct = kind !== "unknown-files" && kind !== "cannot-verify-database" && !block;
  const label = kind === "unclaimed" || kind === "unmarked" ? "Claim this storage" : "Re-bind the storage to this database";
  return (
    <div className="rounded-theme border border-red-300 bg-red-50 p-3 text-sm text-red-900 space-y-2" data-testid="install-identity-problem">
      <p className="font-medium">{title}</p>
      <p>{problem} Until it is put right, nothing in the storage folder is cleaned up or moved. See &ldquo;The install marker&rdquo; in the deployment guide.</p>
      {block && (
        <p className="font-medium">
          {block === "unreadable"
            ? "The storage's marker has a heartbeat that cannot be read, so another site may still be using this folder. Stop any other site that shares it."
            : `Another database used this folder ${block.minutesAgo} minute${block.minutesAgo === 1 ? "" : "s"} ago. Stop the other site that shares this folder (a staging copy, say); this one can take it over from ${block.until} if that site stays stopped.`}
        </p>
      )}
      {kind === "unclaimed" && (
        <p>After the upgrade that added this check, an album that already has photos shows this once. Claim the storage on the live site. Never claim it from a staging site that shares the live folder: a staging copy of the live database knows every photo, and would then clean up the live album&apos;s new files as if they were nobody&apos;s. A claim is refused while files this database does not know are still being added.</p>
      )}
      {(kind === "other-database" || kind === "other-album") && (
        <ul className="list-disc ml-5 space-y-1">
          <li>If this is a staging copy of the live album pointed at the live folder: never re-bind it. Give staging its own copy of the media instead.</li>
          <li>If this album was moved or restored to this server: stop the old album. Re-binding becomes possible once the old one has not used the folder for {waitHours} hours.</li>
        </ul>
      )}
      {(kind === "unmarked" || kind === "no-id") && <p>If this is the album&apos;s own database, claim the storage for it. That is refused unless this database has a photo for nearly every folder in the storage.</p>}
      {canAct && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (!confirm(`${label}? Do this only on the album this storage belongs to, never on a staging site that shares it.`)) return;
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
          {label}
        </Button>
      )}
      {answer && <p role={answer.ok ? "status" : "alert"} className="font-medium">{answer.text}</p>}
    </div>
  );
}
