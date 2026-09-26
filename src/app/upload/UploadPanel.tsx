"use client";

import { useState } from "react";
import { Label } from "@/components/ui";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { Uploader } from "@/components/photos/Uploader";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";
import type { UploadByteLimits } from "@/lib/media/limits";

export function UploadPanel({ initialTrip, initialCollection, maxClipSeconds, maxBytes, annotationActive }: { initialTrip?: { id: string; title: string } | null; initialCollection?: { id: string; title: string } | null; maxClipSeconds: number; maxBytes: UploadByteLimits; annotationActive: boolean }) {
  const [trip, setTrip] = useState<Container | null>(initialTrip ?? null);
  const [collection, setCollection] = useState<Container | null>(initialCollection ?? null);
  const [activity, setActivity] = useState<Container | null>(null);
  const chooseTrip = (v: Container | null) => {
    setTrip(v);
    // An activity belongs to one trip; changing the trip drops a choice that no longer means anything.
    setActivity(null);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="w-full sm:w-64">
          <Label htmlFor="trip">Trip</Label>
          <ContainerPicker kind="trip" value={trip} onChange={chooseTrip} allowNone noneLabel="Match by date taken" placeholder="Match by date taken" />
        </div>
        {/* Only worth offering once a trip is named: an activity is one of its days, not a thing of its own. */}
        {trip && (
          <div className="w-full sm:w-64">
            <Label htmlFor="activity">Activity</Label>
            <ContainerPicker kind="activity" tripId={trip.id} value={activity} onChange={setActivity} allowNone noneLabel="Match by time taken" placeholder="Match by time taken" />
          </div>
        )}
        {/* A collection as well, since a collection is a label rather than a place: they stay on their trip too. */}
        <div className="w-full sm:w-64">
          <Label htmlFor="collection">Collection</Label>
          <ContainerPicker kind="collection" value={collection} onChange={setCollection} allowNone noneLabel="None" placeholder="None" />
        </div>
      </div>
      {/* Not started afresh when the choice above changes: a batch already going keeps the place it was sent to, and
          only files added after the change go to the new one. */}
      <Uploader scope="upload" tripId={trip?.id} activityId={activity?.id} collectionId={collection?.id} maxClipSeconds={maxClipSeconds} maxBytes={maxBytes} annotationActive={annotationActive} />
      <YouTubeAddForm tripId={trip?.id} defaultDate={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
