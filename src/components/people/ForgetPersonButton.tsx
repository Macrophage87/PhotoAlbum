"use client";

import { useEffect, useRef, useState } from "react";
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

/** The button says what it does in the mode chosen, as the question after it does. */
export function forgetButtonLabel(mode: string): string {
  return mode === "keep-name" ? "Forget face data, keep the name" : "Forget completely";
}

const chosenMode = (form: HTMLFormElement | null | undefined) => form?.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value ?? "remove-all";

/** The forget form's submit button: named for whichever mode is chosen, and asking first in that mode's words. */
export function ForgetPersonButton({ name }: { name: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState("remove-all");
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const follow = () => setMode(chosenMode(form));
    follow();
    form.addEventListener("change", follow);
    return () => form.removeEventListener("change", follow);
  }, []);
  return (
    <Button
      ref={ref}
      type="submit"
      variant="danger"
      size="sm"
      onClick={(e) => {
        if (typeof window.confirm === "function" && !window.confirm(forgetConfirmMessage(name, chosenMode(e.currentTarget.form)))) e.preventDefault();
      }}
    >
      {forgetButtonLabel(mode)}
    </Button>
  );
}
