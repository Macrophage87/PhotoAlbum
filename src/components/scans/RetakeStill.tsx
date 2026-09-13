"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { retakeScanStill } from "@/app/photos/[id]/actions";

/**
 * Throw away the picture a scan shows in the grids and let the viewer take another.
 *
 * Offered only once there is a still to replace, and only to somebody who may change the item. It is here rather
 * than buried in the editor because a wrong still is something you notice while looking at the scan.
 */
export function RetakeStill({ photoId }: { photoId: string }) {
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        data-testid="retake-still"
        onClick={() =>
          start(async () => {
            try {
              await retakeScanStill(photoId);
              setFailed(null);
              router.refresh();
            } catch (err) {
              setFailed(err instanceof Error ? err.message : "That did not work");
            }
          })
        }
      >
        {pending ? "Taking it again…" : "Take the picture again"}
      </Button>
      {failed && <span className="text-sm text-red-700" role="alert">{failed}</span>}
    </span>
  );
}
