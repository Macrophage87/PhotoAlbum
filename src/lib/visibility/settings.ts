import type { TripVisibility } from "@/generated/prisma/enums";
import { describeStillExposed, describeWidening, levelOf, summarizeExposure, type ContainerRef, type ItemContainers } from "./exposure";
import { itemsOfContainer } from "./preview";

export type VisibilityWarnings = {
  /** Widening sentences per target visibility, keyed by the value of the radio option. */
  byTarget: Record<TripVisibility, string[]>;
  /** Sentences about items that stay more visible than this container through another container. */
  stillExposed: string[];
  /** Containers (beyond this one) that currently expose some of its items more widely. */
  exposingContainers: ContainerRef[];
  /** How many of this container's items are also reachable through some other container. */
  alsoElsewhere: number;
  total: number;
};

/** Everything a settings page needs to warn about exposure, computed once on the server. */
export async function visibilityWarnings(kind: "trip" | "collection", id: string, current: TripVisibility, label: string): Promise<VisibilityWarnings> {
  const items = await itemsOfContainer(kind, id);
  const byTarget = {} as Record<TripVisibility, string[]>;
  for (const target of ["PRIVATE", "LINK", "PUBLIC"] as const) {
    byTarget[target] = target === current ? [] : describeWidening(summarizeExposure(items, { kind: "setVisibility", container: { kind, id }, visibility: target }), `through this ${kind}`);
  }
  const now = summarizeExposure(items, { kind: "setVisibility", container: { kind, id }, visibility: current });
  const exposing = new Map<string, ContainerRef>();
  for (const s of now.stillExposed) for (const c of s.via) exposing.set(`${c.kind}_${c.id}`, c);
  const other = (item: ItemContainers) => [...(item.trip ? [item.trip] : []), ...item.collections].filter((c) => !(c.kind === kind && c.id === id));
  return {
    byTarget,
    stillExposed: describeStillExposed(now, label),
    exposingContainers: [...exposing.values()].filter((c) => levelOf(c.visibility) > levelOf(current)),
    alsoElsewhere: items.filter((i) => other(i).length > 0).length,
    total: items.length,
  };
}
