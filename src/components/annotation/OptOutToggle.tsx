"use client";

import { useState, useTransition } from "react";
import { setAnnotationOptOut, setContainerAnnotationOptOut } from "@/app/annotation/actions";

/** "Never send to the AI helper" for one item or a whole trip or collection. */
export function OptOutToggle({ target, initial, label }: { target: { kind: "photo"; id: string } | { kind: "trip" | "collection"; id: string }; initial: boolean; label?: string }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          start(async () => {
            if (target.kind === "photo") await setAnnotationOptOut([target.id], next);
            else await setContainerAnnotationOptOut(target.kind, target.id, next);
          });
        }}
        className="mt-1"
      />
      <span>
        <span className="font-medium">{label ?? "Never send to the AI helper"}</span>
        <span className="block text-muted">{target.kind === "photo" ? "This item stays on the server; no description is generated for it." : `Everything in this ${target.kind} stays on the server, whatever the item settings say.`}</span>
      </span>
    </label>
  );
}
