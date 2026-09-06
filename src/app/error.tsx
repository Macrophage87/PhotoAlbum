"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex-1 flex items-center justify-center p-10 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-3xl font-semibold">Something went wrong</h1>
        <p className="text-muted mt-2">{error.message || "An unexpected error occurred."}</p>
        <Button className="mt-4" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
