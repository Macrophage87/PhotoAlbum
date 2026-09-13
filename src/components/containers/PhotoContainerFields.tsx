"use client";

import { useState } from "react";
import { ContainerMultiPicker, ContainerPicker, type Container } from "./ContainerPicker";

/** The trip an item is on, inside the plain edit form: a search box that submits `tripId` as it always did. */
export function TripField({ initial }: { initial: Container | null }) {
  const [trip, setTrip] = useState<Container | null>(initial);
  return <ContainerPicker kind="trip" value={trip} onChange={setTrip} name="tripId" allowNone noneLabel="Not on a trip" placeholder="Search trips…" />;
}

/** The collections an item is in: chips for what it is already in, and the same search to add more. */
export function CollectionsField({ initial, hint }: { initial: Container[]; hint?: string }) {
  const [chosen, setChosen] = useState<Container[]>(initial);
  return <ContainerMultiPicker kind="collection" value={chosen} onChange={setChosen} name="collectionIds" hint={hint} />;
}
