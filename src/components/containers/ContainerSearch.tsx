"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";

/** Narrow the front page to trips and collections whose name matches, so a long history is findable, not scrolled. */
export function ContainerSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  return (
    <form
      className="flex gap-2 max-w-md"
      onSubmit={(e) => { e.preventDefault(); router.push(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/"); }}
    >
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a trip or collection by name" aria-label="Find a trip or collection by name" className="h-9" />
      <Button type="submit" size="sm" variant="secondary">Find</Button>
      {initial && <Button type="button" size="sm" variant="ghost" onClick={() => { setQ(""); router.push("/"); }}>Clear</Button>}
    </form>
  );
}
