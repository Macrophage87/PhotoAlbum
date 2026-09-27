import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIEW_SETTLE_MS, viewAsker, widen } from "@/components/map/view-asker";
import type { MapPhotos } from "@/lib/map/geojson";
import type { MapViewport } from "@/lib/map/view";

/** A map's answers, held back until the test lets each one land. */
function server() {
  const asked: { view: MapViewport; signal: AbortSignal; land: (photos: MapPhotos) => void }[] = [];
  const fetchView = (view: MapViewport, signal: AbortSignal) => new Promise<MapPhotos>((resolve) => asked.push({ view, signal, land: resolve }));
  return { asked, fetchView };
}
const answer = (id: string, grouped = false): MapPhotos => ({ points: [[id, 0, 0, null, 0, 0, null]], cells: grouped ? [{ at: [0, 0], n: 2, box: [0, 0, 0, 0], rings: { day: [], activity: [], uploader: null } }] : [], complete: false, version: "v" });
const view = (west: number, south: number, zoom = 10): MapViewport => ({ west, south, east: west + 1, north: south + 1, zoom });

describe("asking for the view a map is on", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never puts an answer for somewhere else on the map after it has come back", async () => {
    const { asked, fetchView } = server();
    const shown: string[] = [];
    const asker = viewAsker({ fetchView, onAnswer: (p) => shown.push(p.points[0][0]) });
    const A = view(0, 0);
    asker.ask(A);
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    asked[0].land(answer("a"));
    await vi.runAllTimersAsync();
    expect(shown).toEqual(["a"]);

    // Off to B, whose answer is slow…
    asker.ask(view(40, 40));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    expect(asked).toHaveLength(2);
    // …and back into A before it comes: A's photographs are already on the map, so nothing more is asked…
    asker.ask(A);
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS * 2);
    expect(asked).toHaveLength(2);
    expect(asked[1].signal.aborted).toBe(true);
    // …and B's answer, landing late, is dropped rather than drawn over A.
    asked[1].land(answer("b"));
    await vi.runAllTimersAsync();
    expect(shown).toEqual(["a"]);
  });

  it("draws only the answer to the latest question when several are in flight", async () => {
    const { asked, fetchView } = server();
    const shown: string[] = [];
    const asker = viewAsker({ fetchView, onAnswer: (p) => shown.push(p.points[0][0]) });
    asker.ask(view(0, 0));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    asker.ask(view(40, 40));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    // The later answer lands first, then the earlier one.
    asked[1].land(answer("second"));
    asked[0].land(answer("first"));
    await vi.runAllTimersAsync();
    expect(shown).toEqual(["second"]);
  });

  it("asks once for a drag, and again only when the map leaves what was sent or a grouped answer's zoom changes", async () => {
    const { asked, fetchView } = server();
    const asker = viewAsker({ fetchView, onAnswer: () => {} });
    for (let i = 0; i < 5; i++) asker.ask(view(i * 0.01, 0));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    expect(asked).toHaveLength(1);
    expect(asked[0].view).toEqual(widen(view(0.04, 0)));
    asked[0].land(answer("x", true));
    await vi.runAllTimersAsync();
    // A small pan inside the widened view: nothing to ask. A zoom step with groups on the map: they are redone.
    asker.ask(view(0.2, 0.2));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    expect(asked).toHaveLength(1);
    asker.ask(view(0.2, 0.2, 11));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    expect(asked).toHaveLength(2);
  });

  it("asks again at once when told the album changed under the view, and says when the answer is on the map", async () => {
    const { asked, fetchView } = server();
    const shown: string[] = [];
    const asker = viewAsker({ fetchView, onAnswer: (p) => shown.push(p.points[0][0]) });
    expect(await asker.refresh()).toBe(false);
    asker.ask(view(0, 0));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    asked[0].land(answer("before"));
    await vi.runAllTimersAsync();
    const done = asker.refresh();
    expect(asked).toHaveLength(2);
    asked[1].land(answer("after"));
    expect(await done).toBe(true);
    expect(shown).toEqual(["before", "after"]);
  });

  it("counts a view moved to before the refreshed answer came as the answer the album's change is in", async () => {
    const { asked, fetchView } = server();
    const shown: string[] = [];
    const asker = viewAsker({ fetchView, onAnswer: (p) => shown.push(p.points[0][0]) });
    asker.ask(view(0, 0));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    asked[0].land(answer("before"));
    await vi.runAllTimersAsync();
    let settled: boolean | null = null;
    void asker.refresh().then((d) => (settled = d));
    // Panned away before the refreshed answer came: that question is taken back…
    asker.ask(view(40, 40));
    await vi.advanceTimersByTimeAsync(VIEW_SETTLE_MS);
    expect(asked[1].signal.aborted).toBe(true);
    asked[1].land(answer("refreshed"));
    await vi.runAllTimersAsync();
    expect(settled).toBeNull();
    // …and the pan's answer, asked after the change, is the one that settles it.
    asked[2].land(answer("panned"));
    await vi.runAllTimersAsync();
    expect(settled).toBe(true);
    expect(shown).toEqual(["before", "panned"]);
  });
});
