"use client";

import { useState } from "react";
import { Label } from "@/components/ui";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { Uploader } from "@/components/photos/Uploader";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";

export function UploadPanel({ initialTrip, maxClipSeconds, annotationActive }: { initialTrip?: { id: string; title: string } | null; maxClipSeconds: number; annotationActive: boolean }) {
  const [trip, setTrip] = useState<Container | null>(initialTrip ?? null);
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Label htmlFor="trip">Trip</Label>
        <ContainerPicker kind="trip" value={trip} onChange={setTrip} allowNone noneLabel="Match by date taken" placeholder="Match by date taken" />
      </div>
      <Uploader key={trip?.id ?? "none"} tripId={trip?.id} maxClipSeconds={maxClipSeconds} annotationActive={annotationActive} />
      <YouTubeAddForm tripId={trip?.id} defaultDate={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
