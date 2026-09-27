"use client";

import { Button } from "@/components/ui";

/**
 * What forgetting will do, in the mode chosen on the form: the default takes the person page and every tag with the
 * face data, and a confirm that said only "face data" undersold it.
 */
export function forgetConfirmMessage(name: string, mode: string): string {
  return mode === "keep-name"
    ? `Forget ${name}'s face data? Their face templates and groups are deleted, they are no longer recognized, and their name is taken out of everything the AI helper wrote. Their person page and the name on photos already confirmed stay. This cannot be undone.`
    : `Forget ${name} completely? This deletes their person page, every tag of them on photos and their face data, and takes their name out of everything the AI helper wrote. Words members wrote themselves are left as they are. This cannot be undone.`;
}

/** The forget form's submit button, asking first in the words of whichever mode is chosen. */
export function ForgetPersonButton({ name }: { name: string }) {
  return (
    <Button
      type="submit"
      variant="danger"
      size="sm"
      onClick={(e) => {
        const mode = e.currentTarget.form?.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value ?? "remove-all";
        if (typeof window.confirm === "function" && !window.confirm(forgetConfirmMessage(name, mode))) e.preventDefault();
      }}
    >
      Forget face data
    </Button>
  );
}
