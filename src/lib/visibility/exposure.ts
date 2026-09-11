import type { TripVisibility } from "@/generated/prisma/enums";

/** How far an item can be seen: members only, anyone holding a share link, or anyone on the internet. */
export type Level = 0 | 1 | 2;

export const LEVEL_LABEL: Record<Level, string> = { 0: "family members only", 1: "anyone holding the share link", 2: "anyone on the internet" };

export function levelOf(visibility: TripVisibility): Level {
  return visibility === "PUBLIC" ? 2 : visibility === "LINK" ? 1 : 0;
}

export type ContainerRef = { kind: "trip" | "collection"; id: string; slug?: string; title: string; visibility: TripVisibility };
export type ItemContainers = { id: string; trip: ContainerRef | null; collections: ContainerRef[] };

export type Change =
  | { kind: "addToCollection"; collection: ContainerRef }
  | { kind: "moveToTrip"; trip: ContainerRef | null }
  | { kind: "setVisibility"; container: { kind: "trip" | "collection"; id: string }; visibility: TripVisibility };

function containersOf(item: ItemContainers): ContainerRef[] {
  return [...(item.trip ? [item.trip] : []), ...item.collections];
}

/** Effective visibility is the union of the item's containers; an item in no container is members-only. */
export function effectiveLevel(item: ItemContainers): Level {
  return containersOf(item).reduce<Level>((max, c) => Math.max(max, levelOf(c.visibility)) as Level, 0);
}

/** The item's containers after the change, so the same rule computes the new level. */
export function applyChange(item: ItemContainers, change: Change): ItemContainers {
  switch (change.kind) {
    case "addToCollection":
      return item.collections.some((c) => c.id === change.collection.id) ? item : { ...item, collections: [...item.collections, change.collection] };
    case "moveToTrip":
      return { ...item, trip: change.trip };
    case "setVisibility": {
      const swap = (c: ContainerRef) => (c.kind === change.container.kind && c.id === change.container.id ? { ...c, visibility: change.visibility } : c);
      return { ...item, trip: item.trip ? swap(item.trip) : null, collections: item.collections.map(swap) };
    }
  }
}

export type ExposureSummary = {
  /** Items whose effective level rises, grouped by the level they rise to, with the containers they come from. */
  widened: { level: Level; count: number; from: ContainerRef[] }[];
  /** Items that stay more visible than the changed container because another container still exposes them. */
  stillExposed: { level: Level; count: number; via: ContainerRef[] }[];
  total: number;
};

/** Compare every item before and after a change and summarise what the change exposes, or fails to hide. */
export function summarizeExposure(items: ItemContainers[], change: Change): ExposureSummary {
  const widened = new Map<Level, { count: number; from: Map<string, ContainerRef> }>();
  const still = new Map<Level, { count: number; via: Map<string, ContainerRef> }>();
  const targetLevel = change.kind === "setVisibility" ? levelOf(change.visibility) : null;
  for (const item of items) {
    const before = effectiveLevel(item);
    const after = effectiveLevel(applyChange(item, change));
    if (after > before) {
      const entry = widened.get(after) ?? { count: 0, from: new Map() };
      entry.count++;
      for (const c of containersOf(item)) if (levelOf(c.visibility) < after) entry.from.set(`${c.kind}_${c.id}`, c);
      widened.set(after, entry);
    }
    if (change.kind === "setVisibility" && targetLevel !== null && after > targetLevel) {
      // Lowering a container: what still exposes this item beyond the new level?
      const others = containersOf(applyChange(item, change)).filter((c) => !(c.kind === change.container.kind && c.id === change.container.id) && levelOf(c.visibility) > targetLevel);
      if (others.length) {
        const entry = still.get(after) ?? { count: 0, via: new Map() };
        entry.count++;
        for (const c of others) entry.via.set(`${c.kind}_${c.id}`, c);
        still.set(after, entry);
      }
    }
  }
  const sortDesc = (a: { level: Level }, b: { level: Level }) => b.level - a.level;
  return {
    widened: [...widened].map(([level, e]) => ({ level, count: e.count, from: [...e.from.values()] })).sort(sortDesc),
    stillExposed: [...still].map(([level, e]) => ({ level, count: e.count, via: [...e.via.values()] })).sort(sortDesc),
    total: items.length,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const describeContainer = (c: ContainerRef) => `the ${c.visibility === "PRIVATE" ? "private" : c.visibility === "LINK" ? "link-shared" : "public"} ${c.kind} ${c.title}`;
const joinList = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** Plain sentences for a confirm dialog or a settings page. Empty when the change exposes nothing new. */
export function describeWidening(summary: ExposureSummary, target: string): string[] {
  return summary.widened.map((w) => {
    const origin = w.from.length ? ` from ${joinList(w.from.slice(0, 3).map(describeContainer))}${w.from.length > 3 ? " and others" : ""}` : " that only family members could see";
    return `${w.count} of ${plural(summary.total, "photo")}${origin} will become visible to ${LEVEL_LABEL[w.level]} ${target}.`;
  });
}

/** Sentences for the inverse case: lowering a container that does not shrink the union. */
export function describeStillExposed(summary: ExposureSummary, containerLabel: string): string[] {
  return summary.stillExposed.map((s) => `${s.count} of ${containerLabel}'s ${plural(summary.total, "photo")} ${s.count === 1 ? "is" : "are"} also in ${joinList(s.via.slice(0, 3).map(describeContainer))}${s.via.length > 3 ? " and others" : ""} and stay${s.count === 1 ? "s" : ""} visible to ${LEVEL_LABEL[s.level]}.`);
}
