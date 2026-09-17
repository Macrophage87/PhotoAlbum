"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { createNodeImageProgram } from "@sigma/node-image";
import type { GraphPayload } from "@/lib/graph/query";
import { Lightbox, type LightboxPhoto } from "@/components/photos/Lightbox";

type ColourBy = "trip" | "collection" | "person" | "uploader";
const PALETTE = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#65a30d", "#9333ea", "#0d9488", "#ea580c", "#4f46e5"];

function colourFor(key: string | null, index: Map<string, number>): string {
  if (!key) return "#9ca3af";
  if (!index.has(key)) index.set(key, index.size);
  return PALETTE[index.get(key)! % PALETTE.length];
}

/** Sigma.js graph of similar media: thumbnails as nodes, similarity as edges, a threshold slider and a lightbox on click. */
export function GraphView({ data, minScore }: { data: GraphPayload; minScore: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [threshold, setThreshold] = useState(minScore);
  /**
   * How many different answers each way of colouring gives here. Inside one trip, colouring by trip paints every
   * item the same, which says nothing — so start on the first thing that actually tells these items apart.
   */
  const spread = useMemo(
    () => ({
      trip: new Set(data.nodes.map((n) => n.tripId ?? "")).size,
      collection: new Set(data.nodes.map((n) => n.collectionIds[0] ?? "")).size,
      person: new Set(data.nodes.map((n) => n.personIds[0] ?? "")).size,
      uploader: new Set(data.nodes.map((n) => n.uploader)).size,
    }),
    [data],
  );
  const [colourBy, setColourBy] = useState<ColourBy>(() => (["trip", "collection", "person", "uploader"] as const).find((d) => spread[d] > 1) ?? "trip");
  const [open, setOpen] = useState<number | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  const graph = useMemo(() => {
    const g = new Graph({ type: "undirected" });
    // Deterministic starting positions on a spiral: the layout only needs them spread out, not random.
    data.nodes.forEach((n, i) => g.addNode(n.id, { x: Math.cos(i * 2.4) * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * Math.sqrt(i + 1), size: 12, type: "image", image: n.thumb, label: n.alt }));
    for (const e of data.edges) if (!g.hasEdge(e.a, e.b)) g.addEdge(e.a, e.b, { score: e.score, size: 1 + (e.score - 0.75) * 12 });
    forceAtlas2.assign(g, { iterations: Math.min(400, 60 + data.nodes.length), settings: { ...forceAtlas2.inferSettings(g), gravity: 1, scalingRatio: 4 } });
    return g;
  }, [data]);

  const nodeById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const lightboxPhotos = useMemo<LightboxPhoto[]>(() => data.nodes.map((n) => ({ id: n.id, mediumUrl: n.medium, width: null, height: null, caption: n.caption, alt: n.alt, uploadedBy: n.uploader })), [data]);

  useEffect(() => {
    if (!container.current) return;
    const sigma = new Sigma(graph, container.current, {
      nodeProgramClasses: { image: createNodeImageProgram({ size: { mode: "force", value: 256 }, objectFit: "cover" }) },
      defaultNodeType: "image",
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 30,
      allowInvalidContainer: true,
    });
    sigma.on("clickNode", ({ node }) => setOpen(data.nodes.findIndex((n) => n.id === node)));
    sigmaRef.current = sigma;
    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph, data]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const index = new Map<string, number>();
    const degree = new Map<string, number>();
    graph.forEachEdge((e, attrs, a, b) => {
      if (attrs.score >= threshold) {
        degree.set(a, (degree.get(a) ?? 0) + 1);
        degree.set(b, (degree.get(b) ?? 0) + 1);
      }
    });
    sigma.setSetting("edgeReducer", (e, attrs) => ({ ...attrs, hidden: attrs.score < threshold, color: "#94a3b8" }));
    sigma.setSetting("nodeReducer", (id, attrs) => {
      const n = nodeById.get(id);
      const key = !n ? null : colourBy === "trip" ? n.tripId : colourBy === "collection" ? n.collectionIds[0] ?? null : colourBy === "person" ? n.personIds[0] ?? null : n.uploader;
      return { ...attrs, color: colourFor(key, index), size: 10 + Math.min(12, (degree.get(id) ?? 0) * 1.5) };
    });
    sigma.refresh();
  }, [graph, threshold, colourBy, nodeById]);

  const legend = colourBy === "trip" ? data.legend.trips.map((t) => ({ key: t.id, label: t.title })) : colourBy === "collection" ? data.legend.collections.map((c) => ({ key: c.id, label: c.title })) : colourBy === "person" ? data.legend.people.map((p) => ({ key: p.id, label: p.name })) : [...new Set(data.nodes.map((n) => n.uploader))].map((u) => ({ key: u, label: u }));
  const index = new Map<string, number>();
  const visibleEdges = data.edges.filter((e) => e.score >= threshold).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Similarity ≥ <span className="tabular-nums w-10">{threshold.toFixed(2)}</span>
          <input type="range" min={minScore} max={0.98} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Similarity threshold" />
        </label>
        <label className="flex items-center gap-2">
          Colour by
          <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)} className="h-8 rounded-theme border border-border bg-surface px-2">
            <option value="trip">trip</option>
            <option value="collection">collection</option>
            <option value="person">person</option>
            <option value="uploader">uploader</option>
          </select>
        </label>
        <span className="text-muted" role="status">{data.nodes.length} items · {visibleEdges} links{data.capped ? " · capped, choose a trip, collection or person for the rest" : ""}</span>
      </div>
      <div ref={container} className="h-[70vh] rounded-theme border border-border bg-surface" data-testid="graph-canvas" />
      {legend.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {legend.slice(0, 24).map((l) => (
            <li key={l.key} className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: colourFor(l.key, index) }} />{l.label}</li>
          ))}
        </ul>
      )}
      {open !== null && <Lightbox photos={lightboxPhotos} index={open} onClose={() => setOpen(null)} onNavigate={setOpen} />}
    </div>
  );
}
