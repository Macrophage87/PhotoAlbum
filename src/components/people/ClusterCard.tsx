"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { FaceThumb } from "./FaceThumb";
import { NameClusterForm, type Known } from "./NameClusterForm";
import { markNotAFace, nameClusterAs, splitFaceFromCluster } from "@/app/people/actions";

export type ClusterFaceView = { faceId: string; photoId: string; updatedAt: string; width: number | null; height: number | null; box: [number, number, number, number] };
export type ClusterView = {
  id: string;
  faceCount: number;
  faces: ClusterFaceView[];
  looksLike: { id: string; name: string; kind: "HUMAN" | "PET" } | null;
};

/**
 * One group of faces the album thinks are the same person, and everything the family can say about it.
 *
 * Three things can be wrong with a group, and each needs its own answer. The whole group may be somebody already
 * named, which is common — one person turns up as several groups, a different decade or a beard apart — so the
 * album offers the likeness it found and a single press to join them. One face may be a different relative, since
 * a family resembles itself and that is exactly when the album is confidently wrong; that face leaves the group and
 * waits on its own. And one face may be no face at all — a statue, a portrait on the wall — which is said once and
 * never found again.
 */
export function ClusterCard({ cluster, isAdmin, people, pets }: { cluster: ClusterView; isAdmin: boolean; people: Known[]; pets: Known[] }) {
  const [busy, start] = useTransition();
  const [acted, setActed] = useState<string | null>(null);
  const router = useRouter();

  const act = (faceId: string, what: "split" | "notface") =>
    start(async () => {
      if (what === "split") await splitFaceFromCluster(faceId);
      else await markNotAFace(faceId);
      setActed(what === "split" ? "Moved out of this group; it waits on its own." : "Marked as not a face. It will not be found again.");
      router.refresh();
    });

  const shown = cluster.faces.length;
  return (
    <Card className="p-4 space-y-3" data-testid="face-cluster">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium">{cluster.faceCount} face{cluster.faceCount === 1 ? "" : "s"} that look alike</span>
        {shown < cluster.faceCount && <span className="text-xs text-muted">showing {shown}</span>}
      </div>

      <ul className="flex flex-wrap gap-3">
        {cluster.faces.map((f) => (
          <li key={f.faceId} className="w-[72px] text-center">
            <a href={`/photos/${f.photoId}`} title="Open this photograph">
              <FaceThumb photo={{ id: f.photoId, updatedAt: new Date(f.updatedAt), width: f.width, height: f.height }} box={f.box} />
            </a>
            <div className="mt-1 flex flex-col gap-0.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => act(f.faceId, "split")}
                className="text-[11px] leading-tight text-muted hover:text-primary hover:underline disabled:opacity-50"
              >
                not them
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => act(f.faceId, "notface")}
                className="text-[11px] leading-tight text-muted hover:text-red-700 hover:underline disabled:opacity-50"
              >
                not a face
              </button>
            </div>
          </li>
        ))}
      </ul>
      {acted && <p role="status" className="text-xs text-muted">{acted}</p>}

      {cluster.looksLike && (
        <div className="rounded-theme bg-surface-alt p-2 text-sm flex flex-wrap items-center gap-2">
          <span>
            Looks like <span className="font-medium">{cluster.looksLike.name}</span>
            {cluster.looksLike.kind === "PET" ? " (a pet)" : ""}.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => start(async () => { await nameClusterAs(cluster.id, cluster.looksLike!.id); router.refresh(); })}
            className="rounded-theme border border-primary text-primary px-2 py-0.5 text-xs hover:bg-primary hover:text-primary-fg disabled:opacity-50"
          >
            Yes, these are {cluster.looksLike.name}
          </button>
        </div>
      )}

      <NameClusterForm clusterId={cluster.id} isAdmin={isAdmin} people={people} pets={pets} />
    </Card>
  );
}
