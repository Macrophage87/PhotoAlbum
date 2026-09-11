"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button, FieldError, Input, Label } from "@/components/ui";
import { addYouTubeVideo, type VideoFormState } from "@/app/videos/actions";

/** "Add a YouTube video" button that opens a small form; the trip or collection is fixed by the page it sits on. */
export function YouTubeAddForm({ tripId, collectionId, defaultDate }: { tripId?: string; collectionId?: string; defaultDate: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<VideoFormState, FormData>(addYouTubeVideo, { status: "idle" });
  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Add a YouTube video
      </Button>
    );
  }
  return (
    <form action={action} className="rounded-theme border border-border bg-surface p-4 space-y-3 max-w-lg w-full">
      <p className="text-sm text-muted">
        Longer videos live on YouTube. Upload the video there as <b>Unlisted</b>, then paste its link here; the album stores the title and poster and plays the video in place. Unlisted means anyone with the YouTube link can watch, whatever this album&apos;s visibility.
      </p>
      {tripId && <input type="hidden" name="tripId" value={tripId} />}
      {collectionId && <input type="hidden" name="collectionId" value={collectionId} />}
      <div>
        <Label htmlFor="yt-url">YouTube link</Label>
        <Input id="yt-url" name="url" required placeholder="https://youtu.be/…" />
      </div>
      <div className="max-w-xs">
        <Label htmlFor="yt-date">Date it was filmed</Label>
        <Input id="yt-date" name="date" type="date" required defaultValue={defaultDate} />
      </div>
      {state.status === "error" && <FieldError>{state.message}</FieldError>}
      {state.status === "done" && (
        <p className="text-sm text-emerald-800" role="status">
          Added <Link href={`/photos/${state.photoId}`} className="underline">{state.title}</Link>. The poster appears in the gallery shortly.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Fetching…" : "Add video"}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </form>
  );
}
