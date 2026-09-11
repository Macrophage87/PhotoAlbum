import { haversine as haversineMeters } from "@/lib/geo/haversine";

export type Candidate =
  | { kind: "trip"; id: string; title: string; startDay: string; endDay: string; timezone: string; points: { lat: number; lng: number }[]; landmarks: { lat: number; lng: number; title: string }[] }
  | { kind: "collection"; id: string; title: string; description: string | null; tags: Set<string>; peopleIds: Set<string>; centroid: number[] | null; itemCount: number };

export type Item = {
  id: string;
  /** Local calendar day of capture, YYYY-MM-DD, or null. */
  day: string | null;
  lat: number | null;
  lng: number | null;
  tags: Set<string>;
  text: string;
  peopleIds: Set<string>;
  embedding: number[] | null;
  tripId: string | null;
  collectionIds: Set<string>;
};

export type Suggestion = { kind: "trip" | "collection"; id: string; title: string; score: number; reasons: string[] };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "with", "for", "our", "my", "we", "us", "day", "trip", "photos", "collection"]);

/** Words worth matching in a title or description. */
export function words(text: string | null | undefined): Set<string> {
  return new Set((text ?? "").toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Score one item against one candidate; reasons are the sentence fragments shown next to the suggestion. */
export function scoreCandidate(item: Item, c: Candidate): Suggestion | null {
  const reasons: string[] = [];
  let score = 0;
  if (c.kind === "trip") {
    if (item.tripId === c.id) return null;
    if (item.day) {
      const before = dayDiff(item.day, c.startDay);
      const after = dayDiff(c.endDay, item.day);
      if (before >= 0 && after >= 0) {
        score += 0.6;
        reasons.push("taken during the trip");
      } else {
        const gap = Math.min(Math.abs(before), Math.abs(after));
        if (gap <= 2) {
          score += 0.3;
          reasons.push(gap === 1 ? "the day after the trip" : `${gap} days from the trip`);
        }
      }
    }
    if (item.lat !== null && item.lng !== null) {
      let nearest = Infinity;
      let nearestTitle: string | null = null;
      for (const p of c.points) nearest = Math.min(nearest, haversineMeters(item.lat, item.lng, p.lat, p.lng));
      for (const l of c.landmarks) {
        const d = haversineMeters(item.lat, item.lng, l.lat, l.lng);
        if (d < nearest) {
          nearest = d;
          nearestTitle = l.title;
        }
      }
      if (nearest <= 25_000) {
        score += nearest <= 2_000 ? 0.4 : nearest <= 10_000 ? 0.25 : 0.1;
        const km = nearest < 1000 ? `${Math.round(nearest)} m` : `${(nearest / 1000).toFixed(nearest < 10_000 ? 1 : 0)} km`;
        reasons.push(nearestTitle ? `${km} from the ${nearestTitle}` : `${km} from the trip's photos`);
      }
    }
  } else {
    if (item.collectionIds.has(c.id)) return null;
    const titleWords = words(`${c.title} ${c.description ?? ""}`);
    const overlap = [...item.tags].filter((t) => titleWords.has(t));
    const textWords = words(item.text);
    const textOverlap = [...titleWords].filter((w) => textWords.has(w));
    const hits = new Set([...overlap, ...textOverlap]);
    if (hits.size) {
      score += Math.min(0.5, 0.2 * hits.size);
      reasons.push(`mentions ${[...hits].slice(0, 3).join(", ")}`);
    }
    if (item.peopleIds.size && c.peopleIds.size) {
      const shared = [...item.peopleIds].filter((p) => c.peopleIds.has(p)).length;
      if (shared) {
        score += Math.min(0.4, 0.2 * shared);
        reasons.push(shared === 1 ? "the same person appears" : `${shared} of the same people appear`);
      }
    }
    if (item.embedding && c.centroid) {
      const sim = cosine(item.embedding, c.centroid);
      if (sim >= 0.8) {
        score += 0.4;
        reasons.push("looks like the photos already in it");
      } else if (sim >= 0.65) {
        score += 0.2;
        reasons.push("similar to the photos already in it");
      }
    }
  }
  if (score <= 0) return null;
  return { kind: c.kind, id: c.id, title: c.title, score: Math.round(score * 100) / 100, reasons };
}

/** The top suggestions for an item, best first. */
export function suggest(item: Item, candidates: Candidate[], top = 3): Suggestion[] {
  return candidates
    .map((c) => scoreCandidate(item, c))
    .filter((s): s is Suggestion => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
