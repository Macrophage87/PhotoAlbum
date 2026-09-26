"use client";

import { useState, useTransition } from "react";
import { Badge, Button } from "@/components/ui";

/**
 * Whether the helper's description (and the title it wrote) is read by the family only, and — for the uploader or an
 * admin — the way to show it to everyone after reading it through, or to keep it for the family again.
 */
export function ShareHelperText({ membersOnly, share }: { membersOnly: boolean; share?: (everyone: boolean) => Promise<void> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1 text-sm" data-testid="helper-text-visibility">
      <p className="text-muted">
        {membersOnly ? <><Badge>Family only</Badge> It names somebody, or was written from notes, so only the family reads it.</> : "Everyone who can see this item can read it."}
      </p>
      {share && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          data-testid="helper-text-share"
          onClick={() =>
            start(async () => {
              setError(null);
              if (membersOnly && !window.confirm("Show this description, and the title it gave, to everyone who can see this item? Check it names nobody and says nothing only the family should read.")) return;
              try {
                await share(membersOnly);
              } catch (e) {
                setError(e instanceof Error ? e.message : "That did not work; try again");
              }
            })
          }
        >
          {membersOnly ? "Show the helper's description to everyone" : "Keep it for the family"}
        </Button>
      )}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
