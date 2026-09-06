"use client";

import type { ButtonHTMLAttributes } from "react";
import { Button } from "./Button";

/**
 * Submit button for irreversible form actions: asks for confirmation before the form is sent.
 * Falls back to a normal submit when `window.confirm` is unavailable (non-browser environments).
 */
export function ConfirmSubmitButton({
  confirmMessage,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { confirmMessage: string; variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" }) {
  return (
    <Button
      type="submit"
      {...props}
      onClick={(e) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(confirmMessage)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
}
