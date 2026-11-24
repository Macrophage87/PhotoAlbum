"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/** Sends the chosen music files to the album one at a time, and says how each went. */
export function SongUploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  async function send(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    setLines([]);
    for (const file of Array.from(files)) {
      let line: string;
      try {
        const res = await fetch("/api/music", { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
        const answer = (await res.json().catch(() => ({}))) as { title?: string; error?: string };
        line = res.ok ? `Added: ${answer.title ?? file.name}` : `${file.name}: ${answer.error ?? "it could not be added."}`;
      } catch {
        line = `${file.name}: it did not reach the album. Check the connection and try again.`;
      }
      setLines((before) => [...before, line]);
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.flac,.wav" multiple className="sr-only" id="song-files" data-testid="song-files" onChange={(e) => void send(e.target.files)} />
      <Button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Adding…" : "Add songs"}</Button>
      {lines.length > 0 && (
        <ul className="text-sm text-muted space-y-1" aria-live="polite">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Takes one song out of the album, after asking. */
export function RemoveSong({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(`Remove "${title}" from the album's music?`)) return;
          setBusy(true);
          setProblem(null);
          const res = await fetch(`/api/music/${id}`, { method: "DELETE" }).catch(() => null);
          setBusy(false);
          if (res?.ok) router.refresh();
          else setProblem(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "It could not be removed.");
        }}
      >
        Remove
      </Button>
      {problem && <span className="text-sm text-muted">{problem}</span>}
    </span>
  );
}
