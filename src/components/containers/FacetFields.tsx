"use client";

import { useState } from "react";
import { ContainerPicker, type Container } from "./ContainerPicker";

/** The search page's trip filter, inside its plain GET form: submits `trip` as it always did. */
export function TripFacetField({ initial }: { initial: Container | null }) {
  const [trip, setTrip] = useState<Container | null>(initial);
  return <ContainerPicker kind="trip" value={trip} onChange={setTrip} name="trip" allowNone noneLabel="Any trip" placeholder="Any trip" />;
}

/** The same for collections. */
export function CollectionFacetField({ initial }: { initial: Container | null }) {
  const [collection, setCollection] = useState<Container | null>(initial);
  return <ContainerPicker kind="collection" value={collection} onChange={setCollection} name="collection" allowNone noneLabel="Any collection" placeholder="Any collection" />;
}
