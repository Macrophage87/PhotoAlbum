"use client";

import { useState } from "react";
import { ContainerPicker, type Container } from "./ContainerPicker";

/** Narrow a list to one trip, or to the items on none, inside a plain GET form: submits `trip` as it always did. */
export function TripFilterField({ initial }: { initial: Container | null }) {
  const [trip, setTrip] = useState<Container | null>(initial);
  return (
    <ContainerPicker
      kind="trip"
      value={trip}
      onChange={setTrip}
      name="trip"
      allowNone
      noneLabel="Any trip"
      placeholder="Any trip"
      extras={[{ id: "none", title: "Without a trip" }]}
    />
  );
}
