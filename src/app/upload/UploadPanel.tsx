"use client";

import { useState } from "react";
import { Label, Select } from "@/components/ui";
import { Uploader } from "@/components/photos/Uploader";

export function UploadPanel({ trips, initialTripId }: { trips: { id: string; slug: string; title: string }[]; initialTripId?: string }) {
  const [tripId, setTripId] = useState(initialTripId ?? "");
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Label htmlFor="trip">Trip</Label>
        <Select id="trip" value={tripId} onChange={(e) => setTripId(e.target.value)}>
          <option value="">Match by date taken</option>
          {trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </Select>
      </div>
      <Uploader key={tripId} tripId={tripId || undefined} />
    </div>
  );
}
