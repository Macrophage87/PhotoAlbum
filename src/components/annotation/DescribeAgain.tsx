"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { reannotate } from "@/app/annotation/actions";

export const REPLACE_WARNING = "This replaces the description your family wrote with a new one from the helper.";

/**
 * "Describe again". On a description the family wrote or corrected it asks first, since the new one replaces theirs;
 * the album's own passes never do that, so this press is the only way it happens.
 */
export function DescribeAgain({ photoId, hasDescription, edited }: { photoId: string; hasDescription: boolean; edited: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (edited && !window.confirm(REPLACE_WARNING)) return;
        start(async () => {
          await reannotate(photoId, edited);
          router.refresh();
        });
      }}
    >
      {hasDescription ? "Describe again" : "Describe now"}
    </Button>
  );
}
